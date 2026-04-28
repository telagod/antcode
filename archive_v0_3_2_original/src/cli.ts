#!/usr/bin/env node
import { antcodePath, appendJsonl, overwriteJsonl, readJson, readJsonl } from "./storage";
import { buildRewardBundle } from "./reward";
import { canMutate, mutateGenome } from "./mutation";
import { mockAttempt } from "./simulator";
import { realAttempt } from "./realWorker";
import { realTasks } from "./tasks";
import { evaluateExperienceKeyHealth } from "./health";
import { hashExperienceKey, sampleGenome, samplingTable } from "./sampler";
import { decideTournament } from "./tournament";
import {
  Attempt,
  ExperienceKey,
  ExperienceKeyHealth,
  MutationEvent,
  NegativePheromone,
  PolicyConfig,
  RewardBundle,
  StrategyGenome,
  StrategyPheromone,
} from "./types";

const root = process.cwd();

const experienceKeys: ExperienceKey[] = [
  {
    goal_pattern: "add_cli_command",
    module_region: "cli",
    error_pattern: "missing_command_route",
    context_shape: ["existing_command_examples", "cli_tests"],
    risk_level: "low_to_medium",
  },
  {
    goal_pattern: "fix_type_error",
    module_region: "shared",
    error_pattern: "type_mismatch",
    context_shape: ["type_definitions", "usage_sites"],
    risk_level: "low",
  },
  {
    goal_pattern: "refactor_module",
    module_region: "core",
    error_pattern: undefined,
    context_shape: ["module_structure", "dependency_graph", "tests"],
    risk_level: "medium",
  },
];

function loadPolicy(): PolicyConfig {
  return readJson<PolicyConfig>(antcodePath(root, "policy.json"), {
    version: "0.3.2",
    mutation_threshold: {
      min_same_failure_count: 2,
      min_avg_semantic_confidence: 0.35,
      forbid_if_guard_flags: ["weakened_assertion", "hidden_config_bypass"],
    },
    promotion_rule: {
      min_samples: 3,
      semantic_success_improvement: 0.15,
      max_diff_cost_ratio: 1.2,
      boundary_violation: "no_increase",
    },
    evaporation: { positive: 0.05, negative: 0.08 },
  });
}

function updatePheromone(reward: RewardBundle): void {
  const file = antcodePath(root, "strategy-pheromones.jsonl");
  const rows = readJsonl<StrategyPheromone>(file);
  const existing = rows.find(
    (p) => p.experience_key_hash === reward.experience_key_hash && p.strategy_genome_id === reward.strategy_genome_id,
  );
  if (existing) {
    existing.sample_count += 1;
    existing.positive = Number(((existing.positive * 0.8) + reward.reward * 0.2).toFixed(3));
    existing.confidence = Number(Math.min(1, existing.confidence + 0.08).toFixed(3));
    existing.updated_at = new Date().toISOString();
    overwriteJsonl(file, rows);
  } else {
    appendJsonl(file, {
      experience_key_hash: reward.experience_key_hash,
      strategy_genome_id: reward.strategy_genome_id,
      positive: reward.reward,
      confidence: 0.35,
      sample_count: 1,
      updated_at: new Date().toISOString(),
    } satisfies StrategyPheromone);
  }
}

function updateNegative(reward: RewardBundle): void {
  if (reward.failure_mode === "none") return;
  const file = antcodePath(root, "negative-pheromones.jsonl");
  const rows = readJsonl<NegativePheromone>(file);
  const existing = rows.find(
    (n) => n.experience_key_hash === reward.experience_key_hash &&
      n.strategy_genome_id === reward.strategy_genome_id &&
      n.reason === reward.failure_mode,
  );
  const penalty = reward.failure_mode === "reward_hacking" ? 0.8 : reward.failure_mode === "boundary_blocked" ? 0.45 : 0.3;
  if (existing) {
    existing.penalty = Number(Math.min(1, existing.penalty + penalty * 0.2).toFixed(3));
    existing.confidence = Number(Math.min(1, existing.confidence + 0.1).toFixed(3));
    existing.evidence_attempts.push(reward.attempt_id);
    existing.updated_at = new Date().toISOString();
    overwriteJsonl(file, rows);
  } else {
    appendJsonl(file, {
      experience_key_hash: reward.experience_key_hash,
      strategy_genome_id: reward.strategy_genome_id,
      reason: reward.failure_mode,
      penalty,
      confidence: 0.35,
      decay: "medium",
      evidence_attempts: [reward.attempt_id],
      updated_at: new Date().toISOString(),
    } satisfies NegativePheromone);
  }
}

function evaporatePheromones(policy: PolicyConfig): void {
  const posFile = antcodePath(root, "strategy-pheromones.jsonl");
  const negFile = antcodePath(root, "negative-pheromones.jsonl");
  const positives = readJsonl<StrategyPheromone>(posFile);
  const negatives = readJsonl<NegativePheromone>(negFile);

  for (const p of positives) {
    p.positive = Number((p.positive * (1 - policy.evaporation.positive)).toFixed(3));
    p.confidence = Number(Math.max(0.1, p.confidence * (1 - policy.evaporation.positive * 0.5)).toFixed(3));
  }
  for (const n of negatives) {
    const rate = n.decay === "fast" ? policy.evaporation.negative * 1.5 : n.decay === "slow" ? policy.evaporation.negative * 0.5 : policy.evaporation.negative;
    n.penalty = Number(Math.max(0, n.penalty * (1 - rate)).toFixed(3));
    n.confidence = Number(Math.max(0.1, n.confidence * (1 - rate * 0.5)).toFixed(3));
  }
  const aliveNeg = negatives.filter((n) => n.penalty > 0.01);

  overwriteJsonl(posFile, positives);
  overwriteJsonl(negFile, aliveNeg);
}

function runTournaments(genomes: StrategyGenome[], policy: PolicyConfig): void {
  const genomesFile = antcodePath(root, "strategy-genomes.jsonl");
  const mutFile = antcodePath(root, "mutation-events.jsonl");
  const rewards = readJsonl<RewardBundle>(antcodePath(root, "reward-bundles.jsonl"));
  const mutations = readJsonl<MutationEvent>(mutFile);
  let changed = false;

  for (const child of genomes.filter((g) => g.status === "candidate" && g.parent_id)) {
    const parent = genomes.find((g) => g.id === child.parent_id);
    if (!parent) continue;
    const childSamples = rewards.filter((r) => r.strategy_genome_id === child.id).length;
    if (childSamples < policy.promotion_rule.min_samples) continue;

    const { decision, reason } = decideTournament(parent, child, rewards, policy);
    const mut = mutations.find((m) => m.child_strategy === child.id && m.status === "candidate");

    if (decision === "promote") {
      child.status = "active";
      parent.status = "suppressed";
      if (mut) mut.status = "promoted";
      console.log(`  tournament: ${child.id} promoted over ${parent.id} — ${reason}`);
    } else if (decision === "suppress") {
      child.status = "suppressed";
      if (mut) mut.status = "suppressed";
      console.log(`  tournament: ${child.id} suppressed — ${reason}`);
    } else if (decision === "quarantine") {
      child.status = "quarantined";
      if (mut) mut.status = "quarantined";
      console.log(`  tournament: ${child.id} quarantined — ${reason}`);
    } else {
      console.log(`  tournament: ${child.id} vs ${parent.id} — keep_both — ${reason}`);
    }
    changed = true;
  }

  if (changed) {
    overwriteJsonl(genomesFile, genomes);
    overwriteJsonl(mutFile, mutations);
  }
}

const CONCURRENCY = Number(process.env.ANTCODE_CONCURRENCY ?? 3);
let cliAttemptCounter = 0;

async function runExperiment(iterations = 8, useReal = false): Promise<void> {
  const mode = useReal ? `real (LLM, concurrency=${CONCURRENCY})` : "mock";
  console.log(`starting ${iterations} iterations in ${mode} mode`);
  const policy = loadPolicy();
  const genomesFile = antcodePath(root, "strategy-genomes.jsonl");
  let genomes = readJsonl<StrategyGenome>(genomesFile);
  let mutationIndex = readJsonl<MutationEvent>(antcodePath(root, "mutation-events.jsonl")).length + 1;

  for (let i = 0; i < iterations;) {
    if (useReal) {
      const batchSize = Math.min(CONCURRENCY, iterations - i);
      const jobs: Array<{ key: ExperienceKey; genome: StrategyGenome; slotId: number; task: typeof realTasks[0] | undefined }> = [];

      for (let j = 0; j < batchSize; j++) {
        const key = experienceKeys[Math.floor(Math.random() * experienceKeys.length)];
        const positives = readJsonl<StrategyPheromone>(antcodePath(root, "strategy-pheromones.jsonl"));
        const negatives = readJsonl<NegativePheromone>(antcodePath(root, "negative-pheromones.jsonl"));
        let genome: StrategyGenome;
        try {
          genome = sampleGenome(genomes, key, positives, negatives);
        } catch { continue; }
        const task = realTasks.find((t) => t.key.goal_pattern === key.goal_pattern && t.key.module_region === key.module_region);
        jobs.push({ key, genome, slotId: j, task });
      }

      const results = await Promise.allSettled(
        jobs.map((j) => realAttempt(j.key, j.genome, j.task, j.slotId, true)),
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        const job = jobs[j];
        let attempt: Attempt;
        if (r.status === "fulfilled") {
          attempt = r.value;
        } else {
          cliAttemptCounter++;
          attempt = {
            id: `attempt_${String(cliAttemptCounter).padStart(4, "0")}`,
            timestamp: new Date().toISOString(),
            experience_key: job.key,
            strategy_genome_id: job.genome.id,
            worker: "other",
            result: "failure",
            files_changed: [],
            diff_lines: 0,
            tests_added: 0,
            commands_run: [],
            boundary_violations: [],
            notes: [`concurrent error: ${r.reason}`],
          };
        }

        const merged = attempt.notes.some((n) => n.includes("merged to project"));
        console.log(`  [${i + j + 1}] ${job.genome.id} → ${attempt.result}${merged ? " [MERGED]" : ""} (${attempt.notes.join("; ").slice(0, 80)})`);

        const reward = buildRewardBundle(attempt);
        appendJsonl(antcodePath(root, "attempts.jsonl"), attempt);
        appendJsonl(antcodePath(root, "reward-bundles.jsonl"), reward);
        updatePheromone(reward);
        updateNegative(reward);

        const rewards = readJsonl<RewardBundle>(antcodePath(root, "reward-bundles.jsonl"));
        const decision = canMutate(job.genome, rewards, policy);
        if (decision.ok && decision.failureMode && decision.attempts) {
          const attempts = readJsonl<Attempt>(antcodePath(root, "attempts.jsonl")).filter((a) => decision.attempts!.includes(a.id));
          const { child, event } = mutateGenome(job.genome, decision.failureMode, attempts, mutationIndex++, decision.failureModes);
          if (!genomes.some((g) => g.id === child.id)) {
            genomes.push(child);
            appendJsonl(genomesFile, child);
            appendJsonl(antcodePath(root, "mutation-events.jsonl"), event);
            const label = (decision.failureModes && decision.failureModes.length > 1) ? decision.failureModes.join("+") : decision.failureMode;
            console.log(`  [${i + j + 1}] mutation: ${job.genome.id} → ${child.id} (${label})`);
          }
        }
      }

      i += jobs.length;
    } else {
      const key = experienceKeys[Math.floor(Math.random() * experienceKeys.length)];
      const positives = readJsonl<StrategyPheromone>(antcodePath(root, "strategy-pheromones.jsonl"));
      const negatives = readJsonl<NegativePheromone>(antcodePath(root, "negative-pheromones.jsonl"));
      let genome: StrategyGenome;
      try {
        genome = sampleGenome(genomes, key, positives, negatives);
      } catch { i++; continue; }

      const attempt = mockAttempt(key, genome);
      const reward = buildRewardBundle(attempt);
      appendJsonl(antcodePath(root, "attempts.jsonl"), attempt);
      appendJsonl(antcodePath(root, "reward-bundles.jsonl"), reward);
      updatePheromone(reward);
      updateNegative(reward);

      const rewards = readJsonl<RewardBundle>(antcodePath(root, "reward-bundles.jsonl"));
      const decision = canMutate(genome, rewards, policy);
      if (decision.ok && decision.failureMode && decision.attempts) {
        const attempts = readJsonl<Attempt>(antcodePath(root, "attempts.jsonl")).filter((a) => decision.attempts!.includes(a.id));
        const { child, event } = mutateGenome(genome, decision.failureMode, attempts, mutationIndex++, decision.failureModes);
        if (!genomes.some((g) => g.id === child.id)) {
          genomes.push(child);
          appendJsonl(genomesFile, child);
          appendJsonl(antcodePath(root, "mutation-events.jsonl"), event);
          const label = (decision.failureModes && decision.failureModes.length > 1) ? decision.failureModes.join("+") : decision.failureMode;
          console.log(`  [${i + 1}] mutation: ${genome.id} → ${child.id} (${label})`);
        }
      }
      i++;
    }

    // evaporate every 5 rounds
    if (i % 5 === 0 && i > 0) {
      evaporatePheromones(policy);
    }

    // run tournaments every 10 rounds
    if (i % 10 === 0 && i > 0) {
      genomes = readJsonl<StrategyGenome>(genomesFile);
      runTournaments(genomes, policy);
      genomes = readJsonl<StrategyGenome>(genomesFile);
    }
  }

  // final tournament
  genomes = readJsonl<StrategyGenome>(genomesFile);
  runTournaments(genomes, policy);
  genomes = readJsonl<StrategyGenome>(genomesFile);

  const allRewards = readJsonl<RewardBundle>(antcodePath(root, "reward-bundles.jsonl"));
  for (const ek of experienceKeys) {
    const health = evaluateExperienceKeyHealth(hashExperienceKey(ek), allRewards);
    appendJsonl(antcodePath(root, "experience-key-health.jsonl"), health);
  }
  console.log(`ran ${iterations} experiment iterations`);
}

function showGenomes(): void {
  const genomes = readJsonl<StrategyGenome>(antcodePath(root, "strategy-genomes.jsonl"));
  console.table(genomes.map((g) => ({ id: g.id, parent: g.parent_id ?? "-", gen: g.generation, status: g.status, goal: g.applies_to.goal_pattern, maxFiles: g.context_strategy.max_files, patch: g.action_strategy.patch_granularity, maxDiff: g.boundary_strategy.max_diff_lines })));
}

function showMutations(): void {
  const rows = readJsonl<MutationEvent>(antcodePath(root, "mutation-events.jsonl"));
  console.table(rows.map((m) => ({ id: m.id, parent: m.parent_strategy, child: m.child_strategy, trigger: m.triggered_by.failure_mode, status: m.status, type: m.mutation.type })));
}

function showHealth(): void {
  const rows = readJsonl<ExperienceKeyHealth>(antcodePath(root, "experience-key-health.jsonl"));
  console.table(rows.map((h) => ({
    experience_key_hash: h.experience_key_hash,
    sample_count: h.sample_count,
    transfer_success_rate: h.transfer_success_rate,
    diagnosis: h.diagnosis.join(", "),
    action: h.action.join(", "),
  })));
}

function showPolicy(): void {
  const genomes = readJsonl<StrategyGenome>(antcodePath(root, "strategy-genomes.jsonl"));
  const positives = readJsonl<StrategyPheromone>(antcodePath(root, "strategy-pheromones.jsonl"));
  const negatives = readJsonl<NegativePheromone>(antcodePath(root, "negative-pheromones.jsonl"));
  for (const ek of experienceKeys) {
    console.log(`\n--- ${ek.goal_pattern} / ${ek.module_region} ---`);
    const table = samplingTable(genomes, ek, positives, negatives);
    if (table.length) console.table(table.map((r) => ({ ...r, probability: r.probability.toFixed(3), score: r.score.toFixed(3) })));
    else console.log("  (no matching genomes)");
  }
}

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--")) ?? "help";
const useReal = args.includes("--real");
const iterArg = args.find((a) => /^\d+$/.test(a));

if (cmd === "run-experiment") runExperiment(Number(iterArg ?? 8), useReal).catch(console.error);
else if (cmd === "show-genomes") showGenomes();
else if (cmd === "show-mutations") showMutations();
else if (cmd === "show-health") showHealth();
else if (cmd === "show-policy") showPolicy();
else {
  console.log(`AntCode v0.3.2 MVP\n\nCommands:\n  run-experiment [n] [--real]\n  show-policy\n  show-genomes\n  show-mutations\n  show-health`);
}

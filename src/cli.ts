#!/usr/bin/env node
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
import {
  antcodePath,
  overwriteJsonl,
  readJson,
  readJsonl,
  writeJson,
  globalBuffer,
} from "./storage";
import { buildRewardBundle, loadWeights } from "./reward/index";
import { canMutate, mutateGenome, randomExplore } from "./mutation";
import { mockAttempt } from "./simulator";
import { realAttempt, runSharedRecon } from "./realWorker";
import { realTasks } from "./tasks";
import { generateTasks } from "./taskGen";
import {
  approvePatchArtifact,
  getPatchArtifact,
  listPatchArtifacts,
  mergeFilesToProject,
  rejectPatchArtifact,
  rollbackPatchArtifact,
} from "./verify";
import { evaluateExperienceKeyHealth } from "./health";
import { hashExperienceKey, sampleGenome, samplingTable } from "./sampler";
import { decideTournament } from "./tournament";
import { crossover } from "./crossover";
import { WorkerPool } from "./worker/pool";
import { assignFocusAreas } from "./collaboration";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const CONCURRENCY = Number(process.env.ANTCODE_CONCURRENCY ?? 3);

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
    version: "0.4.0",
    mutation_threshold: {
      min_same_failure_count: 2,
      min_avg_semantic_confidence: 0.35,
      forbid_if_guard_flags: ["weakened_assertion", "hidden_config_bypass"],
    },
    promotion_rule: {
      min_samples: 2,
      semantic_success_improvement: 0.08,
      max_diff_cost_ratio: 1.5,
      boundary_violation: "no_increase",
    },
    evaporation: { positive: 0.05, negative: 0.08 },
    exploration_rate: 0.05,
  });
}

const MAX_GENOMES_PER_GOAL = 8;

function pruneWeakGenomes(genomes: StrategyGenome[], rewards: RewardBundle[]): StrategyGenome[] {
  const goals = [...new Set(genomes.map((g) => g.applies_to.goal_pattern))];
  const pruned: string[] = [];

  for (const goal of goals) {
    const goalGenomes = genomes.filter((g) => g.applies_to.goal_pattern === goal);
    if (goalGenomes.length <= MAX_GENOMES_PER_GOAL) continue;

    const scored = goalGenomes.map((g) => {
      const rs = rewards.filter((r) => r.strategy_genome_id === g.id);
      const avgReward = rs.length ? rs.reduce((s, r) => s + r.reward, 0) / rs.length : 0;
      return { g, avgReward, samples: rs.length };
    }).sort((a, b) => b.avgReward - a.avgReward);

    // keep top MAX_GENOMES_PER_GOAL, suppress the rest
    for (let i = MAX_GENOMES_PER_GOAL; i < scored.length; i++) {
      if (scored[i].g.status !== "suppressed" && scored[i].g.status !== "quarantined") {
        scored[i].g.status = "suppressed";
        pruned.push(scored[i].g.id);
      }
    }
  }

  if (pruned.length > 0) {
    console.log(`  pruned ${pruned.length} weak genomes: ${pruned.join(", ")}`);
    overwriteJsonl(storage.genomesFile, genomes);
  }
  return genomes;
}

function createCliStorage(projectRoot: string) {
  return {
    genomesFile: antcodePath(projectRoot, "strategy-genomes.jsonl"),
    mutationFile: antcodePath(projectRoot, "mutation-events.jsonl"),
    attemptsFile: antcodePath(projectRoot, "attempts.jsonl"),
    rewardsFile: antcodePath(projectRoot, "reward-bundles.jsonl"),
    positiveFile: antcodePath(projectRoot, "strategy-pheromones.jsonl"),
    negativeFile: antcodePath(projectRoot, "negative-pheromones.jsonl"),
    healthFile: antcodePath(projectRoot, "experience-key-health.jsonl"),
  };
}

const storage = createCliStorage(root);

function updatePheromone(reward: RewardBundle): void {
  const rows = readJsonl<StrategyPheromone>(storage.positiveFile);
  const existing = rows.find(
    (p) => p.experience_key_hash === reward.experience_key_hash && p.strategy_genome_id === reward.strategy_genome_id,
  );
  if (existing) {
    existing.sample_count += 1;
    existing.positive = Number(((existing.positive * 0.8) + reward.reward * 0.2).toFixed(3));
    existing.confidence = Number(Math.min(1, existing.confidence + 0.08).toFixed(3));
    existing.updated_at = new Date().toISOString();
    overwriteJsonl(storage.positiveFile, rows);
  } else {
    globalBuffer.appendJsonl(storage.positiveFile, {
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
  const rows = readJsonl<NegativePheromone>(storage.negativeFile);
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
    overwriteJsonl(storage.negativeFile, rows);
  } else {
    globalBuffer.appendJsonl(storage.negativeFile, {
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
  const positives = readJsonl<StrategyPheromone>(storage.positiveFile);
  const negatives = readJsonl<NegativePheromone>(storage.negativeFile);

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

  overwriteJsonl(storage.positiveFile, positives);
  overwriteJsonl(storage.negativeFile, aliveNeg);
}

function runTournaments(genomes: StrategyGenome[], policy: PolicyConfig): void {
  const rewards = readJsonl<RewardBundle>(storage.rewardsFile);
  const mutations = readJsonl<MutationEvent>(storage.mutationFile);
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
    overwriteJsonl(storage.genomesFile, genomes);
    overwriteJsonl(storage.mutationFile, mutations);
  }
}

function pickGenomeForKey(genomes: StrategyGenome[], key: ExperienceKey): StrategyGenome | undefined {
  const positives = readJsonl<StrategyPheromone>(storage.positiveFile);
  const negatives = readJsonl<NegativePheromone>(storage.negativeFile);
  const totalSamplesAll = positives.reduce((s, p) => s + p.sample_count, 0);
  try {
    return sampleGenome(genomes, key, positives, negatives, undefined, true, false, totalSamplesAll);
  } catch {
    return undefined;
  }
}

function persistAttemptAndReward(attempt: Attempt): RewardBundle {
  const weights = loadWeights(root);
  const reward = buildRewardBundle(attempt, weights);
  globalBuffer.appendJsonl(storage.attemptsFile, attempt);
  globalBuffer.appendJsonl(storage.rewardsFile, reward);
  updatePheromone(reward);
  updateNegative(reward);
  return reward;
}

function maybeMutateGenome(
  genomes: StrategyGenome[],
  genome: StrategyGenome,
  policy: PolicyConfig,
  mutationIndex: number,
): number {
  const rewards = readJsonl<RewardBundle>(storage.rewardsFile);
  const decision = canMutate(genome, rewards, policy);

  if (decision.ok && decision.failureMode && decision.attempts) {
    const attempts = readJsonl<Attempt>(storage.attemptsFile).filter((a) => decision.attempts!.includes(a.id));
    const { child, event } = mutateGenome(genome, decision.failureMode, attempts, mutationIndex, decision.failureModes);
    if (!genomes.some((g) => g.id === child.id)) {
      genomes.push(child);
      globalBuffer.appendJsonl(storage.genomesFile, child);
      globalBuffer.appendJsonl(storage.mutationFile, event);
    }
    return mutationIndex + 1;
  }

  // ── Random exploration: even if threshold not met, occasionally mutate ──
  const exploreRate = policy.exploration_rate ?? 0.05;
  if (Math.random() < exploreRate) {
    const explore = randomExplore(genome, mutationIndex);
    if (explore && !genomes.some((g) => g.id === explore.child.id)) {
      genomes.push(explore.child);
      globalBuffer.appendJsonl(storage.genomesFile, explore.child);
      globalBuffer.appendJsonl(storage.mutationFile, explore.event);
      return mutationIndex + 1;
    }
  }

  return mutationIndex;
}

function logMutation(round: number, parentId: string, childId: string, failureMode: string | undefined, failureModes?: string[]): void {
  const label = (failureModes && failureModes.length > 1) ? failureModes.join("+") : failureMode;
  console.log(`  [${round}] mutation: ${parentId} → ${childId} (${label})`);
}

let cliAttemptCounter = 0;
let slotCounter = 0;

async function runExperiment(iterations = 8, useReal = false, autoMerge = true): Promise<void> {
  const mode = useReal ? `real (LLM, concurrency=${CONCURRENCY})` : "mock";
  console.log(`starting ${iterations} iterations in ${mode} mode`);
  if (useReal && !process.env.ANTCODE_LLM_API_KEY) {
    console.log("  ANTCODE_LLM_API_KEY is required for real mode. No workbench was created.");
    console.log("  For a no-LLM mechanics check, run: npm run demo");
    return;
  }

  const policy = loadPolicy();
  let genomes = readJsonl<StrategyGenome>(storage.genomesFile);
  let mutationIndex = readJsonl<MutationEvent>(storage.mutationFile).length + 1;

  if (genomes.length === 0) {
    console.log("  No strategy genomes found. Run `npm run init-state` before starting experiments.");
    console.log("  No workbench was created.");
    return;
  }

  let activeTasks = [...realTasks];
  if (useReal) {
    console.log("  generating dynamic tasks...");
    const dynamic = await generateTasks();
    if (dynamic.length > 0) {
      activeTasks = dynamic;
      for (const t of dynamic) {
        if (!experienceKeys.some((k) => k.goal_pattern === t.key.goal_pattern && k.module_region === t.key.module_region)) {
          experienceKeys.push(t.key);
        }
      }
    } else {
      console.log("  fallback to static tasks");
    }
  }

  for (let i = 0; i < iterations;) {
    if (useReal) {
      const batchSize = Math.min(CONCURRENCY, iterations - i);
      await runSharedRecon(slotCounter++);
      const assignments = assignFocusAreas(batchSize);
      const jobs: Array<{ key: ExperienceKey; genome: StrategyGenome; task: typeof realTasks[0] | undefined; assignment: typeof assignments[0] }> = [];

      for (let j = 0; j < batchSize; j++) {
        const task = activeTasks[Math.floor(Math.random() * activeTasks.length)];
        const key = task.key;
        const genome = pickGenomeForKey(genomes, key) ?? genomes.find((g) => g.status === "active") ?? genomes[0];
        if (!genome) continue;
        jobs.push({ key, genome, task, assignment: assignments[j] });
      }

      if (jobs.length === 0) {
        console.log("  No runnable jobs could be created from the current task/genome state; stopping to avoid workbench churn.");
        return;
      }

      const pool = new WorkerPool(CONCURRENCY);
      const jobResults = new Map<number, { status: "fulfilled"; value: { attempt: Attempt; mergeFiles?: Record<string, string> } } | { status: "rejected"; reason: unknown }>();

      for (let j = 0; j < jobs.length; j++) {
        const job = jobs[j];
        pool.submit<{ key: ExperienceKey; genome: StrategyGenome; task: typeof realTasks[0] | undefined; assignment: typeof assignments[0] }, { attempt: Attempt; mergeFiles?: Record<string, string> }>(
          `job_${j}`,
          job,
          async (payload, slotId) => {
            return realAttempt(payload.key, payload.genome, payload.task, slotId, autoMerge, payload.assignment);
          },
        )
          .then((result) => { jobResults.set(j, { status: "fulfilled", value: result }); })
          .catch((reason) => { jobResults.set(j, { status: "rejected", reason }); });
      }

      await pool.drain();

      for (let j = 0; j < jobs.length; j++) {
        const job = jobs[j];
        const r = jobResults.get(j)!;
        let attempt: Attempt;
        let mergeFiles: Record<string, string> | undefined;
        if (r.status === "fulfilled") {
          attempt = r.value.attempt;
          mergeFiles = r.value.mergeFiles;
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
            notes: [`worker error: ${(r.reason as Error)?.message ?? r.reason}`],
          };
        }

        if (mergeFiles && Object.keys(mergeFiles).length > 0) {
          try {
            mergeFilesToProject(mergeFiles);
            attempt.notes.push("merged to project source");
          } catch (e) {
            attempt.notes.push(`merge failed: ${(e as Error).message.slice(0, 80)}`);
          }
        }

        const merged = attempt.notes.some((n) => n.includes("merged to project"));
        const artifact = attempt.notes.find((n) => n.startsWith("artifact:"))?.slice("artifact:".length);
        console.log(`  [${i + j + 1}] ${job.genome.id} → ${attempt.result}${merged ? " [MERGED]" : ""}${artifact ? ` [ARTIFACT ${artifact}]` : ""} (${attempt.notes.join("; ").slice(0, 80)})`);

        const beforeCount = genomes.length;
        persistAttemptAndReward(attempt);
        mutationIndex = maybeMutateGenome(genomes, job.genome, policy, mutationIndex);
        if (genomes.length > beforeCount) {
          const child = genomes[genomes.length - 1];
          const rewards = readJsonl<RewardBundle>(storage.rewardsFile);
          const decision = canMutate(job.genome, rewards, policy);
          logMutation(i + j + 1, job.genome.id, child.id, decision.failureMode, decision.failureModes);
        }
      }

      i += jobs.length;
    } else {
      const key = experienceKeys[Math.floor(Math.random() * experienceKeys.length)];
      const genome = pickGenomeForKey(genomes, key);
      if (!genome) { i++; continue; }

      const attempt = mockAttempt(key, genome);
      const beforeCount = genomes.length;
      persistAttemptAndReward(attempt);
      mutationIndex = maybeMutateGenome(genomes, genome, policy, mutationIndex);
      if (genomes.length > beforeCount) {
        const child = genomes[genomes.length - 1];
        const rewards = readJsonl<RewardBundle>(storage.rewardsFile);
        const decision = canMutate(genome, rewards, policy);
        logMutation(i + 1, genome.id, child.id, decision.failureMode, decision.failureModes);
      }
      i++;
    }

    if (i % 5 === 0 && i > 0) {
      evaporatePheromones(policy);
    }

    if (i % 10 === 0 && i > 0) {
      genomes = readJsonl<StrategyGenome>(storage.genomesFile);
      runTournaments(genomes, policy);
      genomes = readJsonl<StrategyGenome>(storage.genomesFile);

      // prune weak genomes to prevent bloat
      const pruneRewards = readJsonl<RewardBundle>(storage.rewardsFile);
      genomes = pruneWeakGenomes(genomes, pruneRewards);

      const allRewards = readJsonl<RewardBundle>(storage.rewardsFile);
      const goals = [...new Set(genomes.map((g) => g.applies_to.goal_pattern))];
      for (const goal of goals) {
        const active = genomes.filter((g) => g.applies_to.goal_pattern === goal && (g.status === "active" || g.status === "candidate"));
        if (active.length < 2) continue;
        const sorted = active.sort((a, b) => {
          const ra = allRewards.filter((r) => r.strategy_genome_id === a.id);
          const rb = allRewards.filter((r) => r.strategy_genome_id === b.id);
          const avgA = ra.length ? ra.reduce((s, r) => s + r.reward, 0) / ra.length : 0;
          const avgB = rb.length ? rb.reduce((s, r) => s + r.reward, 0) / rb.length : 0;
          return avgB - avgA;
        });
        const parentA = sorted[0];
        const parentB = sorted[1];
        const childId = `${goal.replace(/_/g, "")}_cross_v${parentA.generation + parentB.generation + 1}`;
        if (genomes.some((g) => g.id === childId)) continue;
        const result = crossover(parentA, parentB, allRewards, childId);
        if (result) {
          genomes.push(result.child);
          globalBuffer.appendJsonl(storage.genomesFile, result.child);
          const from = Object.entries(result.inherited).map(([k, v]) => `${k}←${v}`).join(", ");
          console.log(`  crossover: ${result.parentA} × ${result.parentB} → ${result.child.id} (${from})`);
        }
      }
    }
  }

  genomes = readJsonl<StrategyGenome>(storage.genomesFile);
  runTournaments(genomes, policy);
  genomes = readJsonl<StrategyGenome>(storage.genomesFile);
  const finalRewards = readJsonl<RewardBundle>(storage.rewardsFile);
  pruneWeakGenomes(genomes, finalRewards);

  const allRewards = readJsonl<RewardBundle>(storage.rewardsFile);
  for (const ek of experienceKeys) {
    const health = evaluateExperienceKeyHealth(hashExperienceKey(ek), allRewards);
    globalBuffer.appendJsonl(storage.healthFile, health);
  }
  console.log(`ran ${iterations} experiment iterations`);
  globalBuffer.flushAll();
}

function showGenomes(): void {
  const genomes = readJsonl<StrategyGenome>(storage.genomesFile);
  console.table(genomes.map((g) => ({ id: g.id, parent: g.parent_id ?? "-", gen: g.generation, status: g.status, goal: g.applies_to.goal_pattern, maxFiles: g.context_strategy.max_files, patch: g.action_strategy.patch_granularity, maxDiff: g.boundary_strategy.max_diff_lines })));
}

function showMutations(): void {
  const rows = readJsonl<MutationEvent>(storage.mutationFile);
  console.table(rows.map((m) => ({ id: m.id, parent: m.parent_strategy, child: m.child_strategy, trigger: m.triggered_by.failure_mode, status: m.status, type: m.mutation.type })));
}

function showHealth(): void {
  const rows = readJsonl<ExperienceKeyHealth>(storage.healthFile);
  console.table(rows.map((h) => ({
    experience_key_hash: h.experience_key_hash,
    sample_count: h.sample_count,
    transfer_success_rate: h.transfer_success_rate,
    diagnosis: h.diagnosis.join(", "),
    action: h.action.join(", "),
  })));
}

function showPolicy(): void {
  const genomes = readJsonl<StrategyGenome>(storage.genomesFile);
  const positives = readJsonl<StrategyPheromone>(storage.positiveFile);
  const negatives = readJsonl<NegativePheromone>(storage.negativeFile);
  for (const ek of experienceKeys) {
    console.log(`\n--- ${ek.goal_pattern} / ${ek.module_region} ---`);
    const table = samplingTable(genomes, ek, positives, negatives);
    if (table.length) console.table(table.map((r) => ({ ...r, probability: r.probability.toFixed(3), score: r.score.toFixed(3) })));
    else console.log("  (no matching genomes)");
  }
}

function showReport(): void {
  const attempts = readJsonl<Attempt>(storage.attemptsFile);
  const rewards = readJsonl<RewardBundle>(storage.rewardsFile);
  const mutations = readJsonl<MutationEvent>(storage.mutationFile);
  const genomes = readJsonl<StrategyGenome>(storage.genomesFile);

  if (!attempts.length) { console.log("No experiment data. Run an experiment first."); return; }

  const success = attempts.filter((a) => a.result === "success").length;
  const blocked = attempts.filter((a) => a.result === "blocked").length;
  const failure = attempts.filter((a) => a.result === "failure").length;
  const merged = attempts.filter((a) => a.notes.some((n) => n.includes("merged to project"))).length;

  let totalInput = 0, totalOutput = 0, totalCached = 0;
  for (const a of attempts) {
    const tn = a.notes.find((n) => n.startsWith("tokens:"));
    if (tn) {
      const m = tn.match(/in=(\d+),out=(\d+),cached=(\d+)/);
      if (m) { totalInput += Number(m[1]); totalOutput += Number(m[2]); totalCached += Number(m[3]); }
    }
  }
  const cacheRate = totalInput > 0 ? (totalCached / totalInput * 100).toFixed(1) : "0";

  const avgReward = rewards.length ? (rewards.reduce((s, r) => s + r.reward, 0) / rewards.length).toFixed(3) : "0";
  const avgSemantic = rewards.length ? (rewards.reduce((s, r) => s + r.semantic_confidence.score, 0) / rewards.length).toFixed(3) : "0";

  const totalDiff = rewards.reduce((s, r) => s + r.cost.diff_lines, 0);
  const avgDiff = rewards.length ? (totalDiff / rewards.length).toFixed(0) : "0";

  const strategyStats = new Map<string, { attempts: number; success: number; merged: number; avgReward: number }>();
  for (const a of attempts) {
    const s = strategyStats.get(a.strategy_genome_id) ?? { attempts: 0, success: 0, merged: 0, avgReward: 0 };
    s.attempts++;
    if (a.result === "success") s.success++;
    if (a.notes.some((n) => n.includes("merged"))) s.merged++;
    strategyStats.set(a.strategy_genome_id, s);
  }
  for (const [id, s] of strategyStats) {
    const rs = rewards.filter((r) => r.strategy_genome_id === id);
    s.avgReward = rs.length ? rs.reduce((sum, r) => sum + r.reward, 0) / rs.length : 0;
  }

  const failureModes = new Map<string, number>();
  for (const r of rewards) {
    if (r.failure_mode !== "none") failureModes.set(r.failure_mode, (failureModes.get(r.failure_mode) ?? 0) + 1);
  }

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║       AntCode v0.8.2 Experiment Report   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  console.log("── Overview ──");
  console.log(`  Total attempts:    ${attempts.length}`);
  console.log(`  Success:           ${success} (${(success/attempts.length*100).toFixed(1)}%)`);
  console.log(`  Blocked:           ${blocked} (${(blocked/attempts.length*100).toFixed(1)}%)`);
  console.log(`  Failure:           ${failure} (${(failure/attempts.length*100).toFixed(1)}%)`);
  console.log(`  Auto-merged:       ${merged}`);
  console.log(`  Mutations:         ${mutations.length}`);
  console.log(`  Total genomes:     ${genomes.length} (active: ${genomes.filter(g=>g.status==="active").length}, candidate: ${genomes.filter(g=>g.status==="candidate").length}, suppressed: ${genomes.filter(g=>g.status==="suppressed").length})`);

  console.log("\n── Token Usage ──");
  console.log(`  Input tokens:      ${totalInput.toLocaleString()}`);
  console.log(`  Output tokens:     ${totalOutput.toLocaleString()}`);
  console.log(`  Cached tokens:     ${totalCached.toLocaleString()} (${cacheRate}% hit rate)`);
  console.log(`  Total tokens:      ${(totalInput + totalOutput).toLocaleString()}`);
  const estCost = ((totalInput - totalCached) * 0.000005 + totalCached * 0.0000025 + totalOutput * 0.000015).toFixed(4);
  console.log(`  Est. cost (USD):   $${estCost}`);

  console.log("\n── Quality ──");
  console.log(`  Avg reward:        ${avgReward}`);
  console.log(`  Avg semantic:      ${avgSemantic}`);
  console.log(`  Avg diff lines:    ${avgDiff}`);

  if (failureModes.size > 0) {
    console.log("\n── Failure Modes ──");
    for (const [mode, count] of [...failureModes.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${mode}: ${count}`);
    }
  }

  console.log("\n── Strategy Performance ──");
  const rows = [...strategyStats.entries()]
    .sort((a, b) => b[1].success - a[1].success)
    .map(([id, s]) => ({ id, attempts: s.attempts, success: s.success, merged: s.merged, successRate: `${(s.success/s.attempts*100).toFixed(0)}%`, avgReward: s.avgReward.toFixed(3) }));
  console.table(rows);
}

function statusLabel(status: string): string {
  if (status === "pending_review") return "🟡 pending_review";
  if (status === "merged") return "🟢 merged";
  if (status === "rejected") return "⚪ rejected";
  if (status === "rolled_back") return "↩️ rolled_back";
  return status;
}

function readPreview(relPath: string, maxLines = 80): string[] {
  const full = path.resolve(root, relPath);
  try {
    return fs.readFileSync(full, "utf8").split("\n").slice(0, maxLines);
  } catch {
    return [];
  }
}

function reviewAttempt(id?: string): void {
  if (!id) {
    const artifacts = listPatchArtifacts().sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!artifacts.length) {
      console.log("No patch artifacts yet.");
      console.log("\nNext: npx tsx src/cli.ts run-experiment 1 --real --no-auto-merge");
      return;
    }

    const counts = artifacts.reduce<Record<string, number>>((acc, artifact) => {
      acc[artifact.status] = (acc[artifact.status] ?? 0) + 1;
      return acc;
    }, {});

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║          Patch Artifact Review          ║");
    console.log("╚══════════════════════════════════════════╝\n");
    console.log(`Total: ${artifacts.length}  Pending: ${counts.pending_review ?? 0}  Merged: ${counts.merged ?? 0}  Rejected: ${counts.rejected ?? 0}  Rolled back: ${counts.rolled_back ?? 0}`);
    console.log("\nRecent artifacts:");
    console.table(artifacts.slice(0, 20).map((a) => ({
      id: a.id,
      attempt: a.attempt_id,
      status: statusLabel(a.status),
      files: a.files_changed.length,
      diff: a.diff_lines,
      created: a.created_at,
    })));
    const firstPending = artifacts.find((artifact) => artifact.status === "pending_review");
    if (firstPending) {
      console.log(`Next: npx tsx src/cli.ts review-attempt ${firstPending.id}`);
    }
    return;
  }

  const artifact = getPatchArtifact(id);
  if (!artifact) {
    console.log(`No patch artifact found for ${id}`);
    return;
  }

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║             Artifact Detail             ║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log(`ID:        ${artifact.id}`);
  console.log(`Attempt:   ${artifact.attempt_id}`);
  console.log(`Status:    ${statusLabel(artifact.status)}`);
  console.log(`Created:   ${artifact.created_at}`);
  if (artifact.approved_at) console.log(`Approved:  ${artifact.approved_at}`);
  if (artifact.rejected_at) console.log(`Rejected:  ${artifact.rejected_at}`);
  if (artifact.rolled_back_at) console.log(`Rollback:  ${artifact.rolled_back_at}`);
  console.log(`Diff:      ${artifact.diff_lines} lines`);

  console.log("\nChanged files:");
  console.table(artifact.files_changed.map((file) => ({ file })));

  console.log("Paths:");
  console.log(`  Patch:      ${artifact.patch_file}`);
  console.log(`  Files:      ${artifact.files_dir}`);
  console.log(`  Verify log: ${artifact.verification_log}`);
  if (artifact.backup_dir) console.log(`  Backup:     ${artifact.backup_dir}`);

  const preview = readPreview(artifact.patch_file, 80);
  if (preview.length) {
    console.log("\nPatch preview:");
    console.log(preview.join("\n"));
    if (preview.length === 80) console.log("... preview truncated; open patch file for full diff");
  }

  if (artifact.notes.length) {
    console.log("\nNotes:");
    for (const note of artifact.notes.slice(0, 12)) console.log(`- ${note}`);
  }

  console.log("\nSuggested commands:");
  if (artifact.status === "pending_review") {
    console.log(`  npx tsx src/cli.ts approve-attempt ${artifact.id}`);
    console.log(`  npx tsx src/cli.ts reject-attempt ${artifact.id}`);
  } else if (artifact.status === "merged") {
    console.log(`  npx tsx src/cli.ts rollback-attempt ${artifact.id}`);
  } else {
    console.log("  No action required.");
  }
}

function approveAttempt(id?: string): void {
  if (!id) {
    console.log("Usage: approve-attempt <attempt_id|artifact_id>");
    return;
  }
  const artifact = approvePatchArtifact(id);
  console.log(`Approved and merged artifact ${artifact.id}`);
}

function rejectAttempt(id?: string): void {
  if (!id) {
    console.log("Usage: reject-attempt <attempt_id|artifact_id>");
    return;
  }
  const artifact = rejectPatchArtifact(id);
  console.log(`Rejected artifact ${artifact.id}`);
}

function rollbackAttempt(id?: string): void {
  if (!id) {
    console.log("Usage: rollback-attempt <attempt_id|artifact_id>");
    return;
  }
  const artifact = rollbackPatchArtifact(id);
  console.log(`Rolled back artifact ${artifact.id}`);
}

type CliCommand =
  | "run-experiment"
  | "show-genomes"
  | "show-mutations"
  | "show-health"
  | "show-policy"
  | "review-attempt"
  | "approve-attempt"
  | "reject-attempt"
  | "rollback-attempt"
  | "report"
  | "export-strategies"
  | "import-strategies"
  | "help";

interface ParsedCliArgs {
  cmd: CliCommand;
  useReal: boolean;
  autoMerge: boolean;
  iterations: number;
  targetId?: string;
  file?: string;
  topK?: number;
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const args = argv.slice(2);
  const rawCmd = args.find((a) => !a.startsWith("--")) ?? "help";
  const knownCommands: CliCommand[] = [
    "run-experiment",
    "show-genomes",
    "show-mutations",
    "show-health",
    "show-policy",
    "review-attempt",
    "approve-attempt",
    "reject-attempt",
    "rollback-attempt",
    "report",
    "export-strategies",
    "import-strategies",
    "help",
  ];
  const cmd: CliCommand = knownCommands.includes(rawCmd as CliCommand) ? rawCmd as CliCommand : "help";
  const useReal = args.includes("--real");
  const autoMerge = !args.includes("--no-auto-merge");
  const iterArg = args.find((a) => /^\d+$/.test(a));
  const targetId = args.filter((a) => !a.startsWith("--")).find((a) => a !== rawCmd && !/^\d+$/.test(a));
  const topKFlag = args.find((a) => a.startsWith("--top-k="));
  return {
    cmd,
    useReal,
    autoMerge,
    iterations: Number(iterArg ?? 8),
    targetId,
    file: targetId,
    topK: topKFlag ? parseInt(topKFlag.slice("--top-k=".length), 10) : 5,
  };
}


function exportStrategies(topK = 5): void {
  const genomes = readJsonl<StrategyGenome>(storage.genomesFile);
  const rewards = readJsonl<RewardBundle>(storage.rewardsFile);
  const scored = genomes.map((g) => {
    const rs = rewards.filter((r) => r.strategy_genome_id === g.id);
    const avg = rs.length ? rs.reduce((s, r) => s + r.reward, 0) / rs.length : 0;
    return { g, score: avg };
  }).sort((a, b) => b.score - a.score);
  const compact = scored.slice(0, topK).map((s) => ({
    id: s.g.id,
    generation: s.g.generation,
    parent_id: s.g.parent_id,
    status: s.g.status,
    applies_to: s.g.applies_to,
    context_strategy: s.g.context_strategy,
    boundary_strategy: s.g.boundary_strategy,
    action_strategy: s.g.action_strategy,
    validation_strategy: s.g.validation_strategy,
    reward_profile: s.g.reward_profile,
    avg_reward: s.score,
  }));
  const outFile = path.join(root, `.antcode_export_${Date.now()}.json`);
  writeJson(outFile, compact);
  console.log(`Exported ${compact.length} strategies to ${outFile}`);
}

function importStrategies(file: string): void {
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) {
    console.error(`Import file not found: ${fullPath}`);
    return;
  }
  const imported = readJson<StrategyGenome[]>(fullPath, []);
  if (!Array.isArray(imported)) {
    console.error("Import file must contain an array of strategy genomes");
    return;
  }
  const genomes = readJsonl<StrategyGenome>(storage.genomesFile);
  let added = 0;
  for (const g of imported) {
    if (!genomes.some((existing) => existing.id === g.id)) {
      g.status = "candidate";
      genomes.push(g);
      globalBuffer.appendJsonl(storage.genomesFile, g);
      added++;
    }
  }
  globalBuffer.flushAll();
  console.log(`Imported ${added} new strategies. Total genomes: ${genomes.length}`);
}

async function dispatchCli(parsed: ParsedCliArgs): Promise<void> {
  if (parsed.cmd === "run-experiment") {
    await runExperiment(parsed.iterations, parsed.useReal, parsed.autoMerge);
    return;
  }
  if (parsed.cmd === "show-genomes") return showGenomes();
  if (parsed.cmd === "show-mutations") return showMutations();
  if (parsed.cmd === "show-health") return showHealth();
  if (parsed.cmd === "show-policy") return showPolicy();
  if (parsed.cmd === "review-attempt") return reviewAttempt(parsed.targetId);
  if (parsed.cmd === "approve-attempt") return approveAttempt(parsed.targetId);
  if (parsed.cmd === "reject-attempt") return rejectAttempt(parsed.targetId);
  if (parsed.cmd === "rollback-attempt") return rollbackAttempt(parsed.targetId);
  if (parsed.cmd === "report") return showReport();
  if (parsed.cmd === "export-strategies") return exportStrategies(parsed.topK);
  if (parsed.cmd === "import-strategies") {
    if (!parsed.file) { console.error("Usage: import-strategies <file>"); return; }
    return importStrategies(parsed.file);
  }
  console.log("AntCode v0.8.2\n\nCommands:\n  run-experiment [n] [--real] [--no-auto-merge]\n  review-attempt [attempt_id|artifact_id]\n  approve-attempt <attempt_id|artifact_id>\n  reject-attempt <attempt_id|artifact_id>\n  rollback-attempt <attempt_id|artifact_id>\n  report\n  export-strategies [--top-k=n]\n  import-strategies <file>\n  show-policy\n  show-genomes\n  show-mutations\n  show-health");
}

void dispatchCli(parseCliArgs(process.argv)).catch(console.error);

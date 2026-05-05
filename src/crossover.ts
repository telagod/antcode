import { StrategyGenome, RewardBundle } from "./types";
import { readJson, writeJson, tryReadJson } from "./storage";
import path from "node:path";

function cloneStrategyGenome(value: StrategyGenome): StrategyGenome {
  return structuredClone(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface CrossoverResult {
  child: StrategyGenome;
  parentA: string;
  parentB: string;
  inherited: Record<string, string>;
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

// ── Dependency graph: parent modules influence child modules ──
// If context comes from A, boundary should prefer A with probability p.
const MODULE_DEPENDENCIES: Record<string, { dependsOn: string; cohesion: number }[]> = {
  context_strategy: [],
  boundary_strategy: [{ dependsOn: "context_strategy", cohesion: 0.7 }],
  action_strategy: [{ dependsOn: "boundary_strategy", cohesion: 0.6 }],
  validation_strategy: [{ dependsOn: "action_strategy", cohesion: 0.5 }],
  reward_profile: [{ dependsOn: "boundary_strategy", cohesion: 0.4 }],
  mutation_policy: [{ dependsOn: "reward_profile", cohesion: 0.3 }],
};

interface CorrelationRecord {
  field: string;
  reward_correlation: number;
  sample_count: number;
}

function correlationPath(root: string): string {
  return path.join(root, ".antcode", "correlation-matrix.json");
}

function loadCorrelationMatrix(root: string): Map<string, number> {
  const records = tryReadJson<CorrelationRecord[]>(correlationPath(root), []).value;
  return new Map(records.map((r) => [r.field, r.reward_correlation]));
}

function saveCorrelationMatrix(root: string, matrix: Map<string, number>, samples: Map<string, number>): void {
  const records: CorrelationRecord[] = [];
  for (const [field, corr] of matrix) {
    records.push({ field, reward_correlation: corr, sample_count: samples.get(field) ?? 0 });
  }
  writeJson(correlationPath(root), records);
}

function computeFieldCorrelation(
  field: keyof StrategyGenome,
  parentA: StrategyGenome,
  parentB: StrategyGenome,
  rewardsA: RewardBundle[],
  rewardsB: RewardBundle[],
): number | null {
  // Simple heuristic: if parent with higher field value also has higher reward, positive correlation.
  const valA = JSON.stringify((parentA as any)[field]);
  const valB = JSON.stringify((parentB as any)[field]);
  if (valA === valB) return null; // no difference to learn from

  const rewardA = avg(rewardsA.map((r) => r.reward));
  const rewardB = avg(rewardsB.map((r) => r.reward));
  const diff = rewardA - rewardB;
  // encode difference as +1 / -1 for correlation tracking
  return diff > 0 ? 1 : diff < 0 ? -1 : 0;
}

function updateCorrelationMatrix(
  root: string,
  parentA: StrategyGenome,
  parentB: StrategyGenome,
  rewardsA: RewardBundle[],
  rewardsB: RewardBundle[],
): void {
  const matrix = loadCorrelationMatrix(root);
  const samples = new Map<string, number>();
  const fields: (keyof StrategyGenome)[] = [
    "context_strategy",
    "boundary_strategy",
    "action_strategy",
    "validation_strategy",
    "reward_profile",
    "mutation_policy",
  ];
  for (const field of fields) {
    const corr = computeFieldCorrelation(field, parentA, parentB, rewardsA, rewardsB);
    if (corr === null) continue;
    const prev = matrix.get(field as string) ?? 0;
    const n = (samples.get(field as string) ?? 0) + 1;
    // exponential moving average
    matrix.set(field as string, prev * 0.9 + corr * 0.1);
    samples.set(field as string, n);
  }
  saveCorrelationMatrix(root, matrix, samples);
}

function pickWithCohesion<T>(
  moduleName: string,
  a: { genome: StrategyGenome; value: T; score: number },
  b: { genome: StrategyGenome; value: T; score: number },
  previousPicks: Map<string, string>, // module -> parent id
  random = Math.random,
): { value: T; from: string } {
  const deps = MODULE_DEPENDENCIES[moduleName] ?? [];
  let cohesionBonus = 0;
  for (const dep of deps) {
    const prevPick = previousPicks.get(dep.dependsOn);
    if (!prevPick) continue;
    if (prevPick === a.genome.id) cohesionBonus += dep.cohesion;
    else if (prevPick === b.genome.id) cohesionBonus -= dep.cohesion;
  }

  const adjustedA = a.score + cohesionBonus;
  const adjustedB = b.score - cohesionBonus; // cohesionBonus applied symmetrically

  // With small probability (0.05), flip to maintain genetic diversity
  if (random() < 0.05) {
    return adjustedA >= adjustedB ? { value: b.value, from: b.genome.id } : { value: a.value, from: a.genome.id };
  }
  return adjustedA >= adjustedB ? { value: a.value, from: a.genome.id } : { value: b.value, from: b.genome.id };
}

export function crossover(
  parentA: StrategyGenome,
  parentB: StrategyGenome,
  rewards: RewardBundle[],
  childId: string,
  root = process.cwd(),
): CrossoverResult | null {
  if (parentA.applies_to.goal_pattern !== parentB.applies_to.goal_pattern) return null;
  if (parentA.id === parentB.id) return null;
  if (parentA.status === "quarantined" || parentB.status === "quarantined") return null;

  const rewardsA = rewards.filter((r) => r.strategy_genome_id === parentA.id);
  const rewardsB = rewards.filter((r) => r.strategy_genome_id === parentB.id);
  if (rewardsA.length < 2 || rewardsB.length < 2) return null;

  const semanticA = avg(rewardsA.map((r) => r.semantic_confidence.score));
  const semanticB = avg(rewardsB.map((r) => r.semantic_confidence.score));
  const costA = avg(rewardsA.map((r) => r.cost.diff_lines));
  const costB = avg(rewardsB.map((r) => r.cost.diff_lines));
  const rewardA = avg(rewardsA.map((r) => r.reward));
  const rewardB = avg(rewardsB.map((r) => r.reward));

  const child = cloneStrategyGenome(parentA);
  child.id = childId;
  child.parent_id = parentA.id;
  child.generation = Math.max(parentA.generation, parentB.generation) + 1;
  child.status = "candidate";
  const inherited: Record<string, string> = {};
  const previousPicks = new Map<string, string>();

  // context_strategy: pick from parent with higher semantic score
  const ctx = pickWithCohesion(
    "context_strategy",
    { genome: parentA, value: parentA.context_strategy, score: semanticA },
    { genome: parentB, value: parentB.context_strategy, score: semanticB },
    previousPicks,
  );
  child.context_strategy = clone(ctx.value);
  inherited["context_strategy"] = ctx.from;
  previousPicks.set("context_strategy", ctx.from);

  // boundary_strategy: pick from parent with lower diff cost, but cohesion-prefer context parent
  const bnd = pickWithCohesion(
    "boundary_strategy",
    { genome: parentA, value: parentA.boundary_strategy, score: -costA },
    { genome: parentB, value: parentB.boundary_strategy, score: -costB },
    previousPicks,
  );
  child.boundary_strategy = clone(bnd.value);
  inherited["boundary_strategy"] = bnd.from;
  previousPicks.set("boundary_strategy", bnd.from);

  // action_strategy: pick from parent with lower diff cost, cohesion to boundary
  const act = pickWithCohesion(
    "action_strategy",
    { genome: parentA, value: parentA.action_strategy, score: -costA },
    { genome: parentB, value: parentB.action_strategy, score: -costB },
    previousPicks,
  );
  child.action_strategy = clone(act.value);
  inherited["action_strategy"] = act.from;
  previousPicks.set("action_strategy", act.from);

  // validation_strategy: pick from parent with higher semantic score, cohesion to action
  const val = pickWithCohesion(
    "validation_strategy",
    { genome: parentA, value: parentA.validation_strategy, score: semanticA },
    { genome: parentB, value: parentB.validation_strategy, score: semanticB },
    previousPicks,
  );
  child.validation_strategy = clone(val.value);
  inherited["validation_strategy"] = val.from;
  previousPicks.set("validation_strategy", val.from);

  // reward_profile + mutation_policy: from higher reward parent, with cohesion
  const rp = pickWithCohesion(
    "reward_profile",
    { genome: parentA, value: parentA.reward_profile, score: rewardA },
    { genome: parentB, value: parentB.reward_profile, score: rewardB },
    previousPicks,
  );
  child.reward_profile = clone(rp.value);
  inherited["reward_profile"] = rp.from;
  previousPicks.set("reward_profile", rp.from);

  const mp = pickWithCohesion(
    "mutation_policy",
    { genome: parentA, value: parentA.mutation_policy, score: rewardA },
    { genome: parentB, value: parentB.mutation_policy, score: rewardB },
    previousPicks,
  );
  child.mutation_policy = clone(mp.value);
  inherited["mutation_policy"] = mp.from;
  previousPicks.set("mutation_policy", mp.from);

  // Track correlations after crossover so future runs learn
  try {
    updateCorrelationMatrix(root, parentA, parentB, rewardsA, rewardsB);
  } catch {
    // non-fatal: correlation learning is best-effort
  }

  return { child, parentA: parentA.id, parentB: parentB.id, inherited };
}

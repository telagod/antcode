import { StrategyGenome, RewardBundle } from "./types";

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

function pickBetter<T>(
  a: { genome: StrategyGenome; value: T; score: number },
  b: { genome: StrategyGenome; value: T; score: number },
): { value: T; from: string } {
  return a.score >= b.score ? { value: a.value, from: a.genome.id } : { value: b.value, from: b.genome.id };
}

export function crossover(
  parentA: StrategyGenome,
  parentB: StrategyGenome,
  rewards: RewardBundle[],
  childId: string,
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

  // context_strategy: pick from parent with higher semantic score
  const ctx = pickBetter(
    { genome: parentA, value: parentA.context_strategy, score: semanticA },
    { genome: parentB, value: parentB.context_strategy, score: semanticB },
  );
  child.context_strategy = clone(ctx.value);
  inherited["context_strategy"] = ctx.from;

  // action_strategy: pick from parent with lower diff cost
  const act = pickBetter(
    { genome: parentA, value: parentA.action_strategy, score: -costA },
    { genome: parentB, value: parentB.action_strategy, score: -costB },
  );
  child.action_strategy = clone(act.value);
  inherited["action_strategy"] = act.from;

  // validation_strategy: pick from parent with higher semantic score
  const val = pickBetter(
    { genome: parentA, value: parentA.validation_strategy, score: semanticA },
    { genome: parentB, value: parentB.validation_strategy, score: semanticB },
  );
  child.validation_strategy = clone(val.value);
  inherited["validation_strategy"] = val.from;

  // boundary_strategy: pick from parent with higher overall reward
  const bnd = pickBetter(
    { genome: parentA, value: parentA.boundary_strategy, score: rewardA },
    { genome: parentB, value: parentB.boundary_strategy, score: rewardB },
  );
  child.boundary_strategy = clone(bnd.value);
  inherited["boundary_strategy"] = bnd.from;

  // reward_profile + mutation_policy: from higher reward parent
  const rp = pickBetter(
    { genome: parentA, value: parentA.reward_profile, score: rewardA },
    { genome: parentB, value: parentB.reward_profile, score: rewardB },
  );
  child.reward_profile = clone(rp.value);
  inherited["reward_profile"] = rp.from;

  child.mutation_policy = clone(rewardA >= rewardB ? parentA.mutation_policy : parentB.mutation_policy);
  inherited["mutation_policy"] = rewardA >= rewardB ? parentA.id : parentB.id;

  return { child, parentA: parentA.id, parentB: parentB.id, inherited };
}

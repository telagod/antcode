import { PolicyConfig, RewardBundle, StrategyGenome } from "./types";

export type TournamentDecision = "promote" | "suppress" | "quarantine" | "keep_both";

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function decideTournament(
  parent: StrategyGenome,
  child: StrategyGenome,
  rewards: RewardBundle[],
  policy: PolicyConfig,
): { decision: TournamentDecision; reason: string } {
  if (child.status === "quarantined") return { decision: "quarantine", reason: "child already quarantined" };

  const parentRewards = rewards.filter((r) => r.strategy_genome_id === parent.id);
  const childRewards = rewards.filter((r) => r.strategy_genome_id === child.id);

  if (childRewards.some((r) => r.guard_flags.includes("weakened_assertion") || r.guard_flags.includes("hidden_config_bypass"))) {
    return { decision: "quarantine", reason: "child has reward hacking flags" };
  }

  if (parentRewards.length < policy.promotion_rule.min_samples || childRewards.length < policy.promotion_rule.min_samples) {
    return { decision: "keep_both", reason: "not enough samples" };
  }

  const parentSemantic = avg(parentRewards.map((r) => r.semantic_confidence.score));
  const childSemantic = avg(childRewards.map((r) => r.semantic_confidence.score));
  const parentReward = avg(parentRewards.map((r) => r.reward));
  const childReward = avg(childRewards.map((r) => r.reward));
  const parentDiff = avg(parentRewards.map((r) => r.cost.diff_lines));
  const childDiff = avg(childRewards.map((r) => r.cost.diff_lines));

  if (childSemantic < parentSemantic) {
    return { decision: "suppress", reason: "child reward cannot compensate for lower semantic confidence" };
  }

  if (childDiff > parentDiff * policy.promotion_rule.max_diff_cost_ratio) {
    return { decision: "suppress", reason: "child diff cost grew too much" };
  }

  if (
    childSemantic >= parentSemantic + policy.promotion_rule.semantic_success_improvement &&
    childReward >= parentReward
  ) {
    return { decision: "promote", reason: "child improves semantic confidence without reward regression" };
  }

  return { decision: "keep_both", reason: "child is not clearly better yet" };
}

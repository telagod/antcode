import { ExperienceKeyHealth, RewardBundle } from "./types";

function variance(xs: number[]): number {
  if (!xs.length) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
}

export function evaluateExperienceKeyHealth(experienceKeyHash: string, rewards: RewardBundle[]): ExperienceKeyHealth {
  const rs = rewards.filter((r) => r.experience_key_hash === experienceKeyHash);
  const byStrategy = new Map<string, RewardBundle[]>();
  for (const r of rs) byStrategy.set(r.strategy_genome_id, [...(byStrategy.get(r.strategy_genome_id) ?? []), r]);

  const avgRewards = [...byStrategy.values()].map((items) => items.reduce((s, r) => s + r.reward, 0) / items.length);
  const bestShare = avgRewards.length ? Math.max(...avgRewards) / (avgRewards.reduce((s, x) => s + x, 0) || 1) : 0;
  const successRate = rs.length ? rs.filter((r) => r.semantic_confidence.score >= 0.7).length / rs.length : 0;
  const rewardVariance = variance(rs.map((r) => r.reward));
  const failureModes = new Set(rs.map((r) => r.failure_mode).filter((m) => m !== "none"));

  const diagnosis: ExperienceKeyHealth["diagnosis"] = [];
  const action: ExperienceKeyHealth["action"] = [];

  if (rs.some((r) => r.guard_flags.includes("weakened_assertion"))) {
    diagnosis.push("reward_hacking_detected");
    action.push("quarantine_strategy");
  }
  if (rs.length < 3) {
    diagnosis.push("insufficient_samples");
    action.push("collect_more_attempts");
  }
  if (rewardVariance > 0.06 || failureModes.size >= 3) {
    diagnosis.push("noisy_key");
    action.push("watch_for_split");
  }
  if (bestShare > 0.7 && successRate > 0.6) {
    diagnosis.push("usable_and_converging");
    action.push("keep");
  }
  if (diagnosis.length === 0) {
    diagnosis.push("usable_but_uncertain");
    action.push("keep_collecting");
  }

  return {
    experience_key_hash: experienceKeyHash,
    sample_count: rs.length,
    transfer_success_rate: Number(successRate.toFixed(3)),
    strategy_convergence: Number(bestShare.toFixed(3)),
    reward_variance: Number(rewardVariance.toFixed(3)),
    contradiction_count: Math.max(0, failureModes.size - 1),
    diagnosis,
    action,
  };
}

import { Attempt, FailureMode, RewardBundle } from "./types";

export function classifyFailureMode(attempt: Attempt, partialReward: Pick<RewardBundle, "semantic_confidence" | "guard_flags">): FailureMode {
  if (partialReward.guard_flags.includes("weakened_assertion") || partialReward.guard_flags.includes("hidden_config_bypass")) {
    return "reward_hacking";
  }
  if (attempt.boundary_violations.length > 0 || attempt.result === "blocked") {
    return "boundary_blocked";
  }
  if (attempt.tests_added === 0 && attempt.result !== "success") {
    return "missing_test";
  }
  if (attempt.diff_lines > 220 || attempt.files_changed.length > 5) {
    return "patch_too_broad";
  }
  if (partialReward.semantic_confidence.score < 0.45) {
    return "semantic_miss";
  }
  if (attempt.notes.some((n) => n.includes("missing context") || n.includes("underread"))) {
    return "context_underread";
  }
  return "none";
}

export function shouldCreateNegativePheromone(mode: FailureMode): boolean {
  return mode !== "none" && mode !== "experience_key_not_transferable";
}

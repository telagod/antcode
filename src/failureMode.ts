import { Attempt, FailureMode, RewardBundle } from "./types";

/**
 * Classifies a failed attempt into a specific failure mode based on reward signals and attempt data.
 *
 * Classification Order (priority matters — earlier checks take precedence):
 * 1. "reward_hacking"    — Guard flags indicate test-weakening or config bypass (malicious behavior)
 * 2. "boundary_blocked"  — Attempt hit file/system boundaries or was explicitly blocked
 * 3. "missing_test"      — No tests were added and the attempt did not succeed
 * 4. "patch_too_broad"   — Diff exceeds 220 lines OR more than 5 files were changed
 * 5. "semantic_miss"     — Semantic confidence score below 0.45 (low goal-alignment evidence)
 * 6. "context_underread" — Notes mention missing context or underread conditions
 * 7. "none"              — No failure detected; attempt is considered acceptable
 *
 * @param attempt        - The attempt record containing diff metrics, test results, and notes
 * @param partialReward  - Partial reward bundle with semantic confidence and guard flags
 * @returns The classified FailureMode string
 */
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
  return mode !== "none";
}

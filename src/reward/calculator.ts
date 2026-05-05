import { Attempt, RewardBundle } from "../types";
import { classifyFailureMode } from "../failureMode";
import { hashExperienceKey } from "../sampler";
import { RewardWeights } from "./weights";

export function detectGuardFlags(attempt: Attempt): string[] {
  const flags: string[] = [];
  if (attempt.boundary_violations.length > 0) flags.push("boundary_violation");
  if (attempt.notes.some((n) => n.includes("weakened assertion"))) flags.push("weakened_assertion");
  if (attempt.notes.some((n) => n.includes("hidden config"))) flags.push("hidden_config_bypass");
  if (attempt.commands_run.some((c) => c.includes("--skip") || c.includes("test:ignore"))) flags.push("skipped_validation");
  return flags;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function buildRewardBundle(attempt: Attempt, weights?: RewardWeights): RewardBundle {
  const w = weights ?? {
    success_base_success: 0.7,
    success_base_blocked: 0.2,
    success_base_failure: 0.35,
    semantic_weight: 0.25,
    diff_penalty_coeff: 1000,
    file_penalty_coeff: 20,
    guard_penalty_coeff: 0.2,
    token_penalty_coeff: 50000,
    cache_bonus_coeff: 0.05,
    test_bonus: 0.12,
    test_execution_bonus: 0.08,
    boundary_bonus: 0.05,
    reward_hacking_penalty: 0.55,
  };

  const guard_flags = detectGuardFlags(attempt);
  const semanticEvidence: string[] = [];

  let semantic = attempt.result === "success" ? 0.75 : 0.35;
  if (attempt.tests_added > 0) {
    semantic += w.test_bonus;
    semanticEvidence.push("target behavior has test evidence");
  }
  if (attempt.commands_run.some((c) => c.includes("test"))) {
    semantic += w.test_execution_bonus;
    semanticEvidence.push("targeted tests were executed");
  }
  if (attempt.boundary_violations.length === 0) {
    semantic += w.boundary_bonus;
    semanticEvidence.push("no boundary violation observed");
  }
  if (guard_flags.includes("weakened_assertion") || guard_flags.includes("hidden_config_bypass")) {
    semantic -= w.reward_hacking_penalty;
    semanticEvidence.push("reward hacking signal detected");
  }
  semantic = clamp01(semantic);

  const partial = {
    semantic_confidence: { score: semantic, evidence: semanticEvidence },
    guard_flags,
  };
  const failure_mode = classifyFailureMode(attempt, partial);

  const diffPenalty = Math.min(0.25, attempt.diff_lines / w.diff_penalty_coeff);
  const filePenalty = Math.min(0.15, attempt.files_changed.length / w.file_penalty_coeff);
  const guardPenalty = guard_flags.length * w.guard_penalty_coeff;

  const successBase =
    attempt.result === "success"
      ? w.success_base_success
      : attempt.result === "blocked"
        ? w.success_base_blocked
        : w.success_base_failure;

  // extract token usage from notes (format: tokens:in=X,out=Y,cached=Z)
  let inputTokens = 0, outputTokens = 0, cachedTokens = 0;
  const tokenNote = attempt.notes.find((n) => n.startsWith("tokens:"));
  if (tokenNote) {
    const m = tokenNote.match(/in=(\d+),out=(\d+),cached=(\d+)/);
    if (m) { inputTokens = Number(m[1]); outputTokens = Number(m[2]); cachedTokens = Number(m[3]); }
  }

  const totalTokens = inputTokens + outputTokens;
  const tokenPenalty = totalTokens > 0 ? Math.min(0.15, totalTokens / w.token_penalty_coeff) : 0;
  const cacheBonus = inputTokens > 0 ? (cachedTokens / inputTokens) * w.cache_bonus_coeff : 0;

  const reward = clamp01(
    successBase + semantic * w.semantic_weight
    - diffPenalty - filePenalty - guardPenalty - tokenPenalty + cacheBonus,
  );

  return {
    id: `reward_${attempt.id}`,
    attempt_id: attempt.id,
    strategy_genome_id: attempt.strategy_genome_id,
    experience_key_hash: hashExperienceKey(attempt.experience_key),
    reward,
    semantic_confidence: partial.semantic_confidence,
    cost: {
      diff_lines: attempt.diff_lines,
      files_changed: attempt.files_changed.length,
      human_intervention: attempt.result === "blocked" ? 1 : 0,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
    },
    guard_flags,
    failure_mode,
  };
}

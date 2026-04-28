import { Attempt, RewardBundle } from "./types";
import { classifyFailureMode } from "./failureMode";
import { hashExperienceKey } from "./sampler";

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function detectGuardFlags(attempt: Attempt): string[] {
  const flags: string[] = [];
  if (attempt.boundary_violations.length > 0) flags.push("boundary_violation");
  if (attempt.notes.some((n) => n.includes("weakened assertion"))) flags.push("weakened_assertion");
  if (attempt.notes.some((n) => n.includes("hidden config"))) flags.push("hidden_config_bypass");
  if (attempt.commands_run.some((c) => c.includes("--skip") || c.includes("test:ignore"))) flags.push("skipped_validation");
  return flags;
}

export function buildRewardBundle(attempt: Attempt): RewardBundle {
  const guard_flags = detectGuardFlags(attempt);
  const semanticEvidence: string[] = [];

  let semantic = attempt.result === "success" ? 0.75 : 0.35;
  if (attempt.tests_added > 0) {
    semantic += 0.12;
    semanticEvidence.push("target behavior has test evidence");
  }
  if (attempt.commands_run.some((c) => c.includes("test"))) {
    semantic += 0.08;
    semanticEvidence.push("targeted tests were executed");
  }
  if (attempt.boundary_violations.length === 0) {
    semantic += 0.05;
    semanticEvidence.push("no boundary violation observed");
  }
  if (guard_flags.includes("weakened_assertion") || guard_flags.includes("hidden_config_bypass")) {
    semantic -= 0.55;
    semanticEvidence.push("reward hacking signal detected");
  }
  semantic = clamp01(semantic);

  const partial = {
    semantic_confidence: { score: semantic, evidence: semanticEvidence },
    guard_flags,
  };
  const failure_mode = classifyFailureMode(attempt, partial);

  const diffPenalty = Math.min(0.25, attempt.diff_lines / 1000);
  const filePenalty = Math.min(0.15, attempt.files_changed.length / 20);
  const guardPenalty = guard_flags.length * 0.2;
  const successBase = attempt.result === "success" ? 0.7 : attempt.result === "blocked" ? 0.2 : 0.35;

  // extract token usage from notes (format: tokens:in=X,out=Y,cached=Z)
  let inputTokens = 0, outputTokens = 0, cachedTokens = 0;
  const tokenNote = attempt.notes.find((n) => n.startsWith("tokens:"));
  if (tokenNote) {
    const m = tokenNote.match(/in=(\d+),out=(\d+),cached=(\d+)/);
    if (m) { inputTokens = Number(m[1]); outputTokens = Number(m[2]); cachedTokens = Number(m[3]); }
  }

  // token cost penalty: penalize high token usage, reward cache hits
  const totalTokens = inputTokens + outputTokens;
  const tokenPenalty = totalTokens > 0 ? Math.min(0.15, totalTokens / 50000) : 0;
  const cacheBonus = inputTokens > 0 ? (cachedTokens / inputTokens) * 0.05 : 0;

  const reward = clamp01(successBase + semantic * 0.25 - diffPenalty - filePenalty - guardPenalty - tokenPenalty + cacheBonus);

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

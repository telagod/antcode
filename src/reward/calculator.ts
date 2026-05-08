import { Attempt, RewardBundle } from "../types";
import { classifyFailureMode } from "../failureMode";
import { hashExperienceKey } from "../sampler";
import { RewardWeights } from "./weights";
import path from "node:path";

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

/**
 * Returns 1 if `file` is a test sidecar of any target file (same basename + .test.ts/.testUtil.ts,
 * or under tests/ mirroring the source path).
 */
function isTestSidecar(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || /\.testUtil\.tsx?$/.test(file) || file.startsWith("tests/");
}

function isInSameDir(file: string, targetDirs: Set<string>): boolean {
  const d = path.dirname(file);
  return targetDirs.has(d);
}

/**
 * Computes how well `files_changed` matches `target_files`.
 *
 * Returns:
 *   alignment   — strict: fraction of edited files that are in target_files (1.0 = perfect)
 *   containment — lenient: fraction inside target_files OR same-directory OR test sidecar
 *
 * Both 0.0 when no files changed (caller should handle as no-edit case separately).
 */
export function computeAlignment(
  filesChanged: string[],
  targetFiles: string[],
  approvedExtras: Set<string> = new Set(),
): { alignment: number; containment: number } {
  if (filesChanged.length === 0) return { alignment: 0, containment: 0 };
  if (targetFiles.length === 0) {
    // No target — can't measure drift. Treat as fully aligned (don't penalize legacy / mock attempts).
    return { alignment: 1, containment: 1 };
  }
  const targetSet = new Set(targetFiles);

  // NOTE: same-directory was REMOVED in v6 — see cli.ts for rationale.
  // alignment = exact in target_files OR approved escalation
  // containment = alignment + sidecars (test files for target)
  let inTarget = 0;
  let contained = 0;
  for (const f of filesChanged) {
    if (targetSet.has(f) || approvedExtras.has(f)) {
      inTarget += 1;
      contained += 1;
    } else if (isTestSidecar(f)) {
      contained += 1;
    }
  }
  return {
    alignment: inTarget / filesChanged.length,
    containment: contained / filesChanged.length,
  };
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
    alignment_bonus: 0.15,
    drift_penalty: 0.4,
    drift_threshold: 0.3,
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

  // Alignment scoring: did the agent edit what the task asked for?
  // Approved escalations (judge-validated out-of-scope edits) count as in-target.
  const targetFiles = attempt.target_files ?? [];
  const approvedSet = new Set<string>(
    (attempt.escalations ?? [])
      .filter((e) => e.verdict === "approved" || e.verdict === "conditional")
      .map((e) => e.file),
  );
  const rejectedExtras = (attempt.escalations ?? []).filter(
    (e) => e.verdict === "rejected",
  ).length;
  const conditionalExtras = (attempt.escalations ?? []).filter(
    (e) => e.verdict === "conditional",
  ).length;
  const { alignment, containment } = computeAlignment(attempt.files_changed, targetFiles, approvedSet);
  const alignmentBonus = w.alignment_bonus ?? 0.15;
  const driftPenalty = w.drift_penalty ?? 0.4;
  const driftThreshold = w.drift_threshold ?? 0.3;

  if (attempt.files_changed.length > 0 && targetFiles.length > 0) {
    semanticEvidence.push(`alignment=${alignment.toFixed(2)} containment=${containment.toFixed(2)}`);
    if (containment < driftThreshold) {
      guard_flags.push("goal_drift");
      semantic -= driftPenalty;
      semanticEvidence.push(`goal_drift: only ${(containment * 100).toFixed(0)}% of edits within task scope`);
    } else if (alignment >= 0.99) {
      semantic += alignmentBonus;
      semanticEvidence.push("perfect alignment with task target_files");
    } else if (alignment >= 0.5) {
      semantic += alignmentBonus * 0.5;
      semanticEvidence.push("partial alignment with task target_files");
    }
  }

  // Mode F escalation signals: judgment-quality bonuses/penalties.
  if (approvedSet.size > 0 && rejectedExtras === 0) {
    // Agent found genuinely necessary out-of-scope edits and ALL were approved.
    semantic += 0.10;
    semanticEvidence.push(`good judgment: ${approvedSet.size} approved escalation(s)`);
  }
  if (conditionalExtras > 0) {
    guard_flags.push("scope_creep_minor");
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

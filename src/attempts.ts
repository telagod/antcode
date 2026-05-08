import type { ExperienceKey } from "./genome";

/**
 * Classification of why an attempt ended the way it did. Produced by
 * `classifyFailureMode` in `src/failureMode.ts` and consumed by the reward
 * calculator, negative-pheromone writer, and mutation policy.
 *
 * - `none` — Successful attempt with no pathological signal detected.
 * - `missing_test` — Code changed but no tests were added or executed.
 * - `context_underread` — Agent patched without gathering sufficient context
 *   (e.g. skipped required `context_shape` entries).
 * - `boundary_blocked` — Edit touched files outside the strategy's allowed
 *   boundary; see `Attempt.boundary_violations`.
 * - `patch_too_broad` — `Attempt.diff_lines` exceeded
 *   `StrategyGenome.boundary_strategy.max_diff_lines`.
 * - `semantic_miss` — Patch compiled/ran but did not achieve the task
 *   intent (low `semantic_confidence.score`).
 * - `reward_hacking` — Detected guard flags like weakened assertions,
 *   hidden config bypass, or skipped validation.
 * - `repeated_same_failure` — Same genome failed the same way across
 *   multiple attempts on the same experience key.
 * - `experience_key_not_transferable` — A genome that succeeded on one
 *   experience key consistently fails on another, indicating the key
 *   boundary is the problem rather than the strategy.
 */
export type FailureMode =
  | "none"
  | "missing_test"
  | "context_underread"
  | "boundary_blocked"
  | "patch_too_broad"
  | "semantic_miss"
  | "reward_hacking"
  | "repeated_same_failure"
  | "experience_key_not_transferable";

/**
 * Immutable record of a single strategy execution. Captures both the
 * observable outcome and the raw inputs consumed by the reward calculator
 * (`src/reward/calculator.ts`).
 *
 * One attempt per task-run per genome; stored in
 * `.antcode/attempts.jsonl`.
 */
export interface Attempt {
  /** Worker-assigned identifier, typically `"attempt_NNNN-<ISO-timestamp>"`. */
  id: string;
  /** ISO 8601 UTC timestamp at which the attempt completed. */
  timestamp: string;
  /** Classified task shape this attempt addressed. */
  experience_key: ExperienceKey;
  /** Which `StrategyGenome` was sampled to produce this attempt. */
  strategy_genome_id: string;
  /** Execution backend: `"mock"` for the simulator, `"codex"` for the real pi-agent runtime, `"other"` for extension points. */
  worker: "mock" | "codex" | "other";
  /** Terminal outcome. `"blocked"` means the agent stopped short and requires human intervention (contributes to `cost.human_intervention`). */
  result: "success" | "failure" | "blocked";
  /** Project-relative paths of files the agent modified. */
  files_changed: string[];
  /** Total added + removed lines across all `files_changed`. */
  diff_lines: number;
  /** Count of new test *files* (not individual test cases). */
  tests_added: number;
  /** Full argv of validation / tool commands that were executed during the attempt. */
  commands_run: string[];
  /** Human-readable descriptions of out-of-scope edits detected by the boundary checker. Non-empty contributes to the `boundary_violation` guard flag. */
  boundary_violations: string[];
  /** Structured log entries. Recognized prefixes (e.g. `"tokens:in=X,out=Y,cached=Z"`) are parsed by the reward calculator. */
  notes: string[];
  /** Files the task explicitly asked to modify. Empty for tasks without target_files. */
  target_files?: string[];
  /** Task identifier for traceability (matches RealTask key hash or description prefix). */
  task_id?: string;
  /**
   * Agent-requested out-of-scope edits that were reviewed by the escalation judge.
   * See Mode F (boundary escalation) in skill `antcode-workflow`. Absent/empty when
   * the agent stayed within target_files.
   */
  escalations?: EscalationRequest[];
}

/**
 * A request by the agent to modify a file outside its assigned `target_files`,
 * along with the judge's verdict. Files with verdict `"approved"` are merged
 * and do not count as drift. Files with `"rejected"` are treated identically
 * to an unannotated boundary violation (dropped from merge, tracked in
 * `boundary_violations`). `"conditional"` is reserved for future use (currently
 * approved + flagged `scope_creep_minor`).
 */
export interface EscalationRequest {
  /** Project-relative path of the file the agent wanted to modify. */
  file: string;
  /** One-line justification extracted from the agent's manifest notes. */
  reason: string;
  /** Judge's decision. */
  verdict: "approved" | "rejected" | "conditional";
  /** 0..1 score — how strongly the judge believes this belongs with the task. */
  judge_score: number;
  /** Short human-readable explanation of the verdict. */
  judge_rationale: string;
}

/**
 * Computed reward record for a single {@link Attempt}. Deterministic given
 * `(Attempt, RewardWeights)`; see `buildRewardBundle` in
 * `src/reward/calculator.ts`.
 *
 * Stored in `.antcode/rewards.jsonl`. Drives pheromone updates in
 * `src/cli.ts`.
 */
export interface RewardBundle {
  /** `"reward_" + attempt_id`. */
  id: string;
  /** Foreign key to the originating `Attempt.id`. */
  attempt_id: string;
  /** Foreign key to the genome that produced the originating attempt. */
  strategy_genome_id: string;
  /** `hashExperienceKey(attempt.experience_key)` — join key against pheromone tables. */
  experience_key_hash: string;
  /**
   * Final scalar reward in `[0, 1]` (clamped). Roughly:
   * `successBase + semantic·semantic_weight - diff_penalty - file_penalty - guard_penalty - token_penalty + cache_bonus`.
   */
  reward: number;
  /** Proxy for "did the change actually achieve the intent?". */
  semantic_confidence: {
    /** Clamped to `[0, 1]`. */
    score: number;
    /** Human-readable strings describing each contribution to the score (for debugging and audit). */
    evidence: string[];
  };
  /** Resource cost breakdown. `diff_lines` and `files_changed` are copied from the Attempt. */
  cost: {
    diff_lines: number;
    /** Count of changed files (length of `Attempt.files_changed`). */
    files_changed: number;
    /** `1` when `Attempt.result === "blocked"`, otherwise `0`. */
    human_intervention: number;
    /** Parsed from the attempt's `"tokens:"` note; `0` if absent. */
    input_tokens: number;
    /** Parsed from the attempt's `"tokens:"` note; `0` if absent. */
    output_tokens: number;
    /** Parsed from the attempt's `"tokens:"` note; `0` if absent. */
    cached_tokens: number;
  };
  /** Names of detected anti-patterns (e.g. `"boundary_violation"`, `"reward_hacking"`, `"goal_drift"`). See `detectGuardFlags`. */
  guard_flags: string[];
  /** Classified outcome. Drives negative-pheromone creation when not `"none"`. */
  failure_mode: FailureMode;
}

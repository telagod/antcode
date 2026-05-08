/**
 * Lifecycle status of a {@link StrategyGenome}. Controls whether the genome
 * is eligible for sampling by the experiment runner.
 *
 * - `active` — Seed or promoted genome; sampled for live tasks in its
 *   `applies_to` scope.
 * - `candidate` — Freshly mutated child genome under trial. Sampled (so it
 *   can earn reward signal) but must win a tournament before replacing its
 *   parent. See `mutation.ts` and the tournament logic in `cli.ts`.
 * - `suppressed` — Lost a tournament or was superseded. Retained on disk
 *   for auditing/lineage but no longer sampled.
 * - `quarantined` — Triggered a hard safety condition (e.g. reward_hacking);
 *   held out of all sampling pending human review.
 */
export type GenomeStatus = "active" | "candidate" | "suppressed" | "quarantined";

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
 * Categorical namespace for a task. Pheromones, rewards, and genome
 * sampling are all indexed per-key so learning for e.g. "fix_type_error in
 * the reward module" does not leak into "add_cli_command".
 *
 * Hashed into a string key via `hashExperienceKey` in `src/sampler.ts`;
 * the hash is what appears in pheromone/reward rows as
 * `experience_key_hash`.
 *
 * Invariants:
 * - All string fields are non-empty and human-readable identifiers
 *   (see `src/taskGen.ts` validation).
 * - `context_shape` entries are symbolic tags, not file paths — though
 *   `taskGen.ts` may derive them from target_files by stripping
 *   `src/` / `.ts`.
 */
export interface ExperienceKey {
  /** Verb-phrase intent, e.g. `"fix_type_error"`, `"add_cli_command"`, `"refactor_module"`. Enumerated (but not type-constrained) in `taskGen.ts`. */
  goal_pattern: string;
  /** Project subsystem, typically a directory or logical area (e.g. `"reward"`, `"storage"`, `"cli"`). */
  module_region: string;
  /** Error class/code when this key describes a bug. Hashes to `"none"` when absent. */
  error_pattern?: string;
  /** Symbolic context requirements the agent should read before patching (e.g. `["type_definitions", "usage_sites"]`). Order is significant for hashing. */
  context_shape: string[];
  /** Qualitative risk tier. Influences guard sensitivity and cost penalties in the reward calculator. */
  risk_level: "low" | "low_to_medium" | "medium" | "high";
}

/**
 * Mutable "strategy DNA" describing *how* the agent should approach tasks
 * that match `applies_to`. Genomes follow a
 * clone → mutate → sample → tournament → promote lifecycle driven by
 * `src/mutation.ts` and the tournament logic in `src/cli.ts`.
 *
 * Genomes are stored in `.antcode/strategy-genomes.jsonl` (one per line).
 */
export interface StrategyGenome {
  /** Stable identifier in the form `"{lineage}_v{generation}"` (see `src/mutation.ts`). */
  id: string;
  /** Genome this was cloned from, or `null` for seed genomes. */
  parent_id: string | null;
  /** Monotonic generation counter within this lineage; `0` for seeds. */
  generation: number;
  /** Lifecycle gate controlling whether this genome is sampled. See {@link GenomeStatus}. */
  status: GenomeStatus;
  /** Scope in which this genome competes for sampling. Matched against {@link ExperienceKey} fields of the same names. */
  applies_to: {
    goal_pattern: string;
    module_region: string;
    risk_level?: string;
  };
  /** How much and what context to gather before patching. */
  context_strategy: {
    /** Ordered list of symbolic context sources (mirrors `ExperienceKey.context_shape`). */
    read_order: string[];
    /** Upper bound on files read before an edit. */
    max_files: number;
    /** If true, the agent must perform a read-only scouting pass before proposing any edit. */
    scout_first: boolean;
  };
  /** Size/style of patches and style constraints. */
  action_strategy: {
    /** Target patch size tier; enforced qualitatively by the agent and quantitatively by `boundary_strategy.max_diff_lines`. */
    patch_granularity: "tiny" | "small" | "medium" | "large";
    /** Prefer mimicking existing code patterns rather than introducing new abstractions. */
    prefer_existing_pattern: boolean;
    /** Forbid architectural changes (new modules, renamed public APIs, etc.). */
    forbid_architecture_change: boolean;
  };
  /** Validation commands per attempt. */
  validation_strategy: {
    /** Commands that MUST pass for the attempt to count as `"success"`. */
    required: string[];
    /** Commands run for informational signal only; failure does not block success. */
    optional: string[];
  };
  /** File- and size-boundary constraints for edits. */
  boundary_strategy: {
    /** Policy name (e.g. `"affected_module_only"`, `"any"`); interpreted by the boundary checker. */
    allowed_file_policy: string;
    /** Maximum total added+removed lines across all files in a single attempt. */
    max_diff_lines: number;
  };
  /** Signals this genome should optimize for vs. avoid. Used by `detectGuardFlags` and reward weighting. */
  reward_profile: {
    optimize_for: string[];
    punish: string[];
  };
  /** For each observed {@link FailureMode}, the genome field paths that should be mutated in response. Consumed by `src/mutation.ts`. */
  mutation_policy: Array<{
    if_failure_mode: FailureMode;
    mutate: string[];
  }>;
  /** Rolling sampling statistics maintained across attempts. `avg_reward` and `avg_semantic_confidence` are both in the range `[0, 1]`. */
  stats?: {
    samples: number;
    avg_reward: number;
    avg_semantic_confidence: number;
  };
}

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
  /** Which {@link StrategyGenome} was sampled to produce this attempt. */
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
 * Per-patch on-disk manifest written by `createPatchArtifact` in
 * `src/verify.ts`. Stored at
 * `.antcode/artifacts/<id>/manifest.json`.
 *
 * Represents the reviewable patch lifecycle:
 * `created` → `pending_review` → (`merged` | `rejected` | `rolled_back`).
 * Each transition sets the corresponding `*_at` timestamp.
 */
export interface PatchArtifactManifest {
  /** Safe filename derived from `attempt_id`; used as the directory name under `.antcode/artifacts/`. */
  id: string;
  /** Foreign key to `Attempt.id` that produced this patch. */
  attempt_id: string;
  /** ISO 8601 UTC creation time. */
  created_at: string;
  /** ISO 8601 UTC time the patch was approved (moved to `status: "merged"`). Absent until approval. */
  approved_at?: string;
  /** ISO 8601 UTC time the patch was rejected. Absent unless `status === "rejected"`. */
  rejected_at?: string;
  /** ISO 8601 UTC time the patch was rolled back. Absent unless `status === "rolled_back"`. */
  rolled_back_at?: string;
  /** Snapshot of the Attempt's `files_changed` at artifact-creation time. */
  files_changed: string[];
  /** Snapshot of the Attempt's `diff_lines` at artifact-creation time. */
  diff_lines: number;
  /** Project-relative path to the unified diff file (`patch.diff` inside the artifact directory). */
  patch_file: string;
  /** Project-relative path to a directory containing full copies of every changed file at patch time. */
  files_dir: string;
  /** Project-relative path to the verification output log. */
  verification_log: string;
  /** Project-relative path to a backup of the pre-patch files. Created at approval time; consumed by rollback. */
  backup_dir?: string;
  /** Current lifecycle state. */
  status: "pending_review" | "merged" | "rejected" | "rolled_back";
  /** Free-form notes appended across lifecycle transitions. */
  notes: string[];
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

/**
 * Positive reinforcement signal for a genome on a specific experience key.
 * One row per `(experience_key_hash, strategy_genome_id)` pair. Written
 * and maintained by `updatePheromone` / `evaporatePheromones` in
 * `src/cli.ts`; read by the sampler in `src/sampler.ts`.
 *
 * Stored in `.antcode/strategy-pheromones.jsonl`.
 */
export interface StrategyPheromone {
  /** `hashExperienceKey(key)` — join key against {@link RewardBundle.experience_key_hash}. */
  experience_key_hash: string;
  /** Genome this pheromone belongs to. */
  strategy_genome_id: string;
  /** Exponentially-weighted moving average of reward in `[0, 1]`. Update rule: `0.8·old + 0.2·new`. Decays by factor `(1 - evaporation.positive)` during evaporation. */
  positive: number;
  /** Confidence in `positive`, in `[0.1, 1]`. Grows `+0.08` per update; decays by `(1 - 0.5·evaporation.positive)` during evaporation (floored at `0.1`). */
  confidence: number;
  /** Monotonic count of reward updates merged into this row. */
  sample_count: number;
  /** ISO 8601 UTC of the most recent update (equal to creation time for new rows). */
  updated_at: string;
}

/**
 * Penalty signal written when `classifyFailureMode` returns a
 * pathological {@link FailureMode} for an attempt. Multiple rows per
 * `(experience_key_hash, strategy_genome_id)` are allowed — one per
 * distinct `reason`.
 *
 * Stored in `.antcode/negative-pheromones.jsonl`. Rows with
 * `penalty <= 0.01` are garbage-collected during evaporation.
 */
export interface NegativePheromone {
  /** `hashExperienceKey(key)` — scope of the penalty. */
  experience_key_hash: string;
  /** Genome being penalized. */
  strategy_genome_id: string;
  /** The {@link FailureMode} that triggered the penalty. One row per reason per (key, genome). */
  reason: FailureMode;
  /** Accumulated penalty magnitude in `[0, 1]`. Grows by `penalty·0.2` per failed attempt; decays by `(1 - rate)` during evaporation, where `rate` is scaled by `decay`. */
  penalty: number;
  /** Confidence in `penalty`, in `[0.1, 1]`. Grows `+0.1` per update; decays with `penalty` during evaporation. */
  confidence: number;
  /** Decay rate class. Effective rate = `evaporation.negative × {fast: 1.5, medium: 1.0, slow: 0.5}`. */
  decay: "fast" | "medium" | "slow";
  /** `Attempt.id` list cited as evidence for this penalty — audit trail. Appended on each matching failure. */
  evidence_attempts: string[];
  /** ISO 8601 UTC of the most recent update. */
  updated_at: string;
}

/**
 * Audit log entry for a strategy mutation. Immutable except for `status`,
 * which is updated by the tournament logic after the child has been
 * sampled enough times. Written by `src/mutation.ts`; tournament
 * outcomes update it in `src/cli.ts`.
 *
 * Stored in `.antcode/mutations.jsonl`.
 */
export interface MutationEvent {
  /** Monotonic identifier of the form `"mut_NNNN"`. */
  id: string;
  /** ISO 8601 UTC of the mutation. */
  timestamp: string;
  /** `StrategyGenome.id` before the mutation. */
  parent_strategy: string;
  /** `StrategyGenome.id` of the newly-created child. */
  child_strategy: string;
  /** Provenance — the observation that justified mutating. */
  triggered_by: {
    /** Experience key where repeated failures were observed. */
    experience_key_hash: string;
    /** Driving {@link FailureMode}. When compound, the primary mode. */
    failure_mode: FailureMode;
    /** `Attempt.id`s cited as evidence. */
    attempts: string[];
  };
  /** Concrete changes applied to the genome. */
  mutation: {
    /** Mutation rule name (e.g. `"patch_granularity_down"`) or `"compound[a+b]"` when multiple rules fired. */
    type: string;
    /** Map of genome field path → `{from, to}` pair describing each edit. */
    changed: Record<string, { from: unknown; to: unknown }>;
  };
  /** Short natural-language reason — surfaced for researchers/maintainers to audit the mutation policy. */
  hypothesis: string;
  /**
   * Tournament outcome. Starts as `"candidate"`; transitions to
   * `"promoted"` (child replaces parent), `"suppressed"` (child
   * discarded), `"quarantined"` (child violated safety checks during
   * creation), or `"keep_both"` (both parent and child remain active
   * because they specialize on different sub-shapes).
   */
  status: "candidate" | "promoted" | "suppressed" | "quarantined" | "keep_both";
}

/**
 * Tunable coefficients for the reward formula implemented in
 * `buildRewardBundle` (`src/reward/calculator.ts`). Persisted at
 * `.antcode/reward-weights.json`; defaults live in `DEFAULT_WEIGHTS`
 * (`src/reward/weights.ts`) and are clamped to safe ranges by
 * `clampWeights`.
 *
 * The final reward (clamped to `[0, 1]`) is approximately:
 * ```
 *   reward = success_base[result]
 *          + semantic_confidence · semantic_weight
 *          - diff_penalty - file_penalty - guard_penalty - token_penalty
 *          + cache_bonus
 * ```
 * where `semantic_confidence` itself is built up additively from the
 * `*_bonus` / `*_penalty` weights below.
 *
 * Adjusted online by `recalibrateWeights` in `src/reward/calibrator.ts`,
 * which gradient-descends MSE against historical rewards and writes a
 * {@link WeightCalibrationRecord} per run.
 */
export interface RewardWeights {
  /** Base reward when `Attempt.result === "success"`. Clamped `[0, 1]`. Default 0.7. */
  success_base_success: number;
  /** Base reward when `Attempt.result === "blocked"` (agent stopped and asked for help). Clamped `[0, 1]`. Default 0.2. */
  success_base_blocked: number;
  /** Base reward when `Attempt.result === "failure"`. Intentionally above 0 so that honest failure beats a blocked stall. Clamped `[0, 1]`. Default 0.35. */
  success_base_failure: number;
  /** Multiplier on `semantic_confidence.score` when summing into the final reward. Clamped `[0, 1]`. Default 0.25. */
  semantic_weight: number;
  /** Divisor on `Attempt.diff_lines` for the diff-size penalty (`min(0.25, diff_lines / coeff)`). Larger ⇒ more lenient. Clamped `[100, 10000]`. Default 1000. */
  diff_penalty_coeff: number;
  /** Divisor on `files_changed.length` for the file-count penalty (`min(0.15, files / coeff)`). Larger ⇒ more lenient. Clamped `[5, 100]`. Default 20. */
  file_penalty_coeff: number;
  /** Per-flag penalty applied for each entry in `RewardBundle.guard_flags`. Clamped `[0.05, 1]`. Default 0.2. */
  guard_penalty_coeff: number;
  /** Divisor on `input_tokens + output_tokens` for the token-cost penalty (`min(0.15, total / coeff)`). Larger ⇒ more lenient. Clamped `[10000, 200000]`. Default 50000. */
  token_penalty_coeff: number;
  /** Multiplier on the cache-hit ratio (`cached_tokens / input_tokens`) for the cache bonus. Clamped `[0, 0.5]`. Default 0.05. */
  cache_bonus_coeff: number;
  /** Added to `semantic_confidence` when `Attempt.tests_added > 0`. Clamped `[0, 0.5]`. Default 0.12. */
  test_bonus: number;
  /** Added to `semantic_confidence` when any command in `Attempt.commands_run` mentions `"test"`. Clamped `[0, 0.5]`. Default 0.08. */
  test_execution_bonus: number;
  /** Added to `semantic_confidence` when `Attempt.boundary_violations` is empty. Clamped `[0, 0.5]`. Default 0.05. */
  boundary_bonus: number;
  /** Subtracted from `semantic_confidence` when `weakened_assertion` or `hidden_config_bypass` is detected by `detectGuardFlags`. Clamped `[0.1, 1]`. Default 0.55. */
  reward_hacking_penalty: number;
  /** Bonus added to semantic_confidence when alignment === 1.0 (all edited files in target_files); half-credit when alignment ≥ 0.5. Clamped `[0, 0.5]`. Default 0.15. */
  alignment_bonus?: number;
  /** Penalty subtracted from semantic_confidence when containment < drift_threshold (also adds the `goal_drift` guard flag). Clamped `[0, 1]`. Default 0.4. */
  drift_penalty?: number;
  /** Containment ratio below which we flag `goal_drift` and apply `drift_penalty`. Range 0..1. Default 0.3. */
  drift_threshold?: number;
}

/**
 * Audit record produced by `recalibrateWeights` in
 * `src/reward/calibrator.ts` each time a gradient-descent pass runs over
 * historical (Attempt, RewardBundle) pairs. Appended to
 * `.antcode/weight-calibration-history.json`; the file is capped at the
 * 20 most recent records by `recordCalibration`.
 */
export interface WeightCalibrationRecord {
  /** ISO 8601 UTC timestamp at which this calibration completed. */
  timestamp: string;
  /** Snapshot of {@link RewardWeights} after the descent step (post-clamp). */
  weights: RewardWeights;
  /** Mean-squared error of the calibrated weights against the historical reward sample, lower is better. */
  mse: number;
  /** Number of (Attempt, RewardBundle) pairs that fed the descent step. */
  samples_used: number;
}

export interface PolicyConfig {
  version: string;
  mutation_threshold: {
    min_same_failure_count: number;
    min_avg_semantic_confidence: number;
    forbid_if_guard_flags: string[];
  };
  promotion_rule: {
    min_samples: number;
    semantic_success_improvement: number;
    max_diff_cost_ratio: number;
    boundary_violation: "no_increase" | "allow_small_increase";
  };
  evaporation: {
    positive: number;
    negative: number;
  };
  exploration_rate: number;
}

export type ExperienceKeyHealthDiagnosis =
  | "insufficient_samples"
  | "noisy_key"
  | "usable_and_converging"
  | "usable_but_uncertain"
  | "reward_hacking_detected";

export type ExperienceKeyHealthAction =
  | "collect_more_attempts"
  | "watch_for_split"
  | "keep"
  | "keep_collecting"
  | "quarantine_strategy";

export interface ExperienceKeyHealth {
  experience_key_hash: string;
  sample_count: number;
  transfer_success_rate: number;
  strategy_convergence: number;
  reward_variance: number;
  contradiction_count: number;
  diagnosis: ExperienceKeyHealthDiagnosis[];
  action: ExperienceKeyHealthAction[];
}

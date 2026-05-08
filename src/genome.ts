import type { FailureMode } from "./attempts";

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

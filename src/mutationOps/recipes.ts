import type { FailureMode } from "../types";

/**
 * Evidence collected from prior attempts that informs runtime-aware
 * mutation rules (e.g. `use_evidence`). Populated by the interpreter
 * in `../mutationOps.ts` from the attempt log.
 */
export interface MutationEvidence {
  actual_diff_lines?: number;
  actual_files_changed?: number;
  boundary_violations?: string[];
  notes?: string[];
}

/**
 * Represents an individual mutation rule that modifies a specific field in a StrategyGenome.
 *
 * @example
 * ```ts
 * // Set a field to a specific value
 * { type: "set", field: "boundary_strategy.max_diff_lines", value: 200 }
 *
 * // Toggle a boolean field
 * { type: "toggle", field: "context_strategy.scout_first" }
 *
 * // Add a value to the beginning of an array field
 * { type: "prepend", field: "validation_strategy.required", value: "run_targeted_test" }
 *
 * // Add a value to the end of an array field
 * { type: "push", field: "reward_profile.optimize_for", value: "explicit_goal_evidence" }
 *
 * // Remove duplicates from an array, optionally preserving specific values
 * { type: "dedupe", field: "validation_strategy.required", exclude: ["targeted_test"] }
 *
 * // Adjust a numeric field by a delta, optionally clamped to min/max
 * { type: "adjust", field: "boundary_strategy.max_diff_lines", delta: 1.5, min: 10, max: 500 }
 *
 * // Replace substring in a string field
 * { type: "replace", field: "boundary_strategy.allowed_file_policy", search: "plus_one", replace: "plus_two" }
 *
 * // Clamp a numeric field to bounds without delta adjustment
 * { type: "clamp", field: "boundary_strategy.max_diff_lines", min: 50, max: 300 }
 *
 * // Move an enum field down in a defined order (e.g., large → medium)
 * { type: "downgrade_enum", field: "action_strategy.patch_granularity", value: ["large", "medium", "small", "tiny"] }
 *
 * // Adjust field based on runtime evidence (actual values observed)
 * { type: "use_evidence", field: "context_strategy.max_files", min: 3, max: 14, delta: 2 }
 * ```
 */
export interface MutationRule {
  type: string;
  field: string;
  value?: unknown;
  delta?: number;
  min?: number;
  max?: number;
  search?: string;
  replace?: string;
  exclude?: string[];
}

/**
 * Defines how a StrategyGenome should be mutated when a specific failure mode is detected.
 *
 * A recipe consists of:
 * - `if_failure_mode`: The failure mode that triggers this recipe
 * - `mutation_type`: Classification of the mutation strategy for tracking/analytics
 * - `hypothesis_template`: Human-readable explanation of why this mutation is attempted;
 *   supports placeholders: `{files_needed}`, `{diff}`, `{old_max}`, `{notes}`
 * - `rules`: Ordered list of MutationRules to apply sequentially to the genome
 *
 * Field path patterns follow the StrategyGenome structure:
 * - `context_strategy.*` - Controls how much context is read (read_order, max_files, scout_first)
 * - `action_strategy.*` - Controls patch generation behavior (patch_granularity, prefer_existing_pattern, forbid_architecture_change)
 * - `validation_strategy.*` - Controls test requirements (required[], optional[])
 * - `boundary_strategy.*` - Controls file/diff boundaries (allowed_file_policy, max_diff_lines)
 * - `reward_profile.*` - Controls reward optimization targets (optimize_for[], punish[])
 * - Top-level: `status` for special cases like quarantine
 *
 * @example
 * ```ts
 * const recipe: MutationRecipe = {
 *   if_failure_mode: "context_underread",
 *   mutation_type: "context_expansion",
 *   hypothesis_template: "Strategy under-read dependencies (needed ~{files_needed} files).",
 *   rules: [
 *     { type: "prepend", field: "context_strategy.read_order", value: "critical_dependency_scan" },
 *     { type: "use_evidence", field: "context_strategy.max_files", min: 3, max: 14, delta: 2 },
 *   ],
 * };
 * ```
 */
export interface MutationRecipe {
  if_failure_mode: FailureMode;
  mutation_type: string;
  hypothesis_template: string;
  rules: MutationRule[];
}

/**
 * Default mutation recipes that map failure modes to corrective genome modifications.
 *
 * Each recipe contains:
 * - `if_failure_mode`: Failure type this recipe addresses
 * - `mutation_type`: Classification of the mutation strategy
 * - `hypothesis_template`: Explanation of the mutation hypothesis; supports placeholders:
 *   - `{files_needed}`: Number of files actually needed (from evidence)
 *   - `{diff}`: Actual diff lines observed
 *   - `{old_max}`: Previous max_diff_lines value
 *   - `{notes}`: Weak evidence notes from attempts
 * - `rules`: Ordered mutations to apply to the StrategyGenome
 *
 * ## Recipe: missing_test
 * **Trigger**: `if_failure_mode = "missing_test"`
 * **Type**: `validation_order_change`
 * **Problem**: Patching happened before expected behavior was locked by tests.
 *
 * **Field paths modified**:
 * - `validation_strategy.required[]` - Array of required validation steps
 *
 * **Valid operators used**:
 * - `prepend`: Add "write_or_update_targeted_test" and "run_targeted_test" to the front of required validations
 * - `dedupe`: Remove stale targeted test entries while preserving others
 *
 * **Intended use**: When tests are missing, prioritize writing and running targeted tests before patching.
 */
export const DEFAULT_MUTATION_RECIPES: MutationRecipe[] = [
  {
    if_failure_mode: "missing_test",
    mutation_type: "validation_order_change",
    hypothesis_template: "Patching happened before expected behavior was locked by tests.",
    rules: [
      { type: "prepend", field: "validation_strategy.required", value: "write_or_update_targeted_test" },
      { type: "prepend", field: "validation_strategy.required", value: "run_targeted_test" },
      { type: "dedupe", field: "validation_strategy.required", exclude: ["targeted_test", "write_or_update_targeted_test", "run_targeted_test"] },
    ],
  },
  {
    if_failure_mode: "context_underread",
    mutation_type: "context_expansion",
    hypothesis_template: "Strategy under-read dependencies (needed ~{files_needed} files).",
    rules: [
      { type: "prepend", field: "context_strategy.read_order", value: "critical_dependency_scan" },
      { type: "use_evidence", field: "context_strategy.max_files", min: 3, max: 14, delta: 2 },
    ],
  },
  {
    if_failure_mode: "boundary_blocked",
    mutation_type: "boundary_adaptive_expansion",
    hypothesis_template: "Boundary too narrow (actual diff={diff}, was max={old_max}).",
    rules: [
      { type: "set", field: "boundary_strategy.allowed_file_policy", value: "affected_module_plus_tests_plus_one_hop_dependency" },
      { type: "use_evidence", field: "boundary_strategy.max_diff_lines", max: 500, delta: 1.2 },
    ],
  },
  {
    if_failure_mode: "patch_too_broad",
    mutation_type: "patch_adaptive_reduction",
    hypothesis_template: "Patch too broad (actual diff={diff}, shrinking).",
    rules: [
      { type: "downgrade_enum", field: "action_strategy.patch_granularity", value: ["large", "medium", "small", "tiny"] },
      { type: "use_evidence", field: "boundary_strategy.max_diff_lines", max: 500, delta: 0.8 },
      { type: "clamp", field: "boundary_strategy.max_diff_lines", min: 80 },
    ],
  },
  {
    if_failure_mode: "semantic_miss",
    mutation_type: "semantic_evidence_tightening",
    hypothesis_template: "Tests passed without proving goal. Evidence: {notes}",
    rules: [
      { type: "push", field: "reward_profile.optimize_for", value: "explicit_goal_evidence" },
    ],
  },
  {
    if_failure_mode: "reward_hacking",
    mutation_type: "quarantine",
    hypothesis_template: "Reward hacking signal detected; preserved only for audit.",
    rules: [
      { type: "set", field: "status", value: "quarantined" },
    ],
  },
];

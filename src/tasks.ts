import { ExperienceKey } from "./types";

export interface RealTask {
  key: ExperienceKey;
  description: string;
  target_files: string[];
  acceptance: {
    typecheck: boolean;
    test_command?: string;
    expected_output?: string;
  };
  /** 1 (highest) to 5 (lowest). Lower number = scheduled first. Default 3. */
  priority?: number;
  /** True if any target file is "large" (>500 lines). Sampler avoids large-patch genomes when true. */
  is_large?: boolean;
}

export const realTasks: RealTask[] = [
  {
    key: {
      goal_pattern: "add_cli_command",
      module_region: "cli",
      error_pattern: "missing_command_route",
      context_shape: ["existing_command_examples", "cli_tests"],
      risk_level: "low_to_medium",
    },
    description: `Add a new CLI command "show-health" to cli.ts that:
1. Reads .antcode/experience-key-health.jsonl
2. Prints a table showing: experience_key_hash, sample_count, transfer_success_rate, diagnosis (joined), action (joined)
3. Follow the same pattern as showGenomes() and showMutations()
4. Register it in the command dispatch at the bottom of the file`,
    target_files: ["src/cli.ts"],
    acceptance: {
      typecheck: true,
      test_command: "npx tsx src/cli.ts show-health",
    },
  },
  {
    key: {
      goal_pattern: "fix_type_error",
      module_region: "shared",
      error_pattern: "type_mismatch",
      context_shape: ["type_definitions", "usage_sites"],
      risk_level: "low",
    },
    description: `Fix the type error in src/health.ts:
The function evaluateExperienceKeyHealth currently returns ExperienceKeyHealth but the "diagnosis" field sometimes pushes a value that doesn't match the expected type.
Specifically, add a new diagnosis value "reward_hacking_detected" when any reward in the set has guard_flags containing "weakened_assertion".
Update the ExperienceKeyHealth type in types.ts if needed to accept this new diagnosis string, and add the corresponding action "quarantine_strategy".`,
    target_files: ["src/health.ts", "src/types.ts"],
    acceptance: {
      typecheck: true,
    },
  },
  {
    key: {
      goal_pattern: "refactor_module",
      module_region: "core",
      error_pattern: undefined,
      context_shape: ["module_structure", "dependency_graph", "tests"],
      risk_level: "medium",
    },
    description: `Refactor src/mutation.ts:
Extract the applyOneMutation function into its own file src/mutationOps.ts.
- Move ONLY applyOneMutation to the new file
- Export it from src/mutationOps.ts
- Import it in src/mutation.ts
- Ensure src/index.ts re-exports from the new file
- All existing functionality must remain unchanged`,
    target_files: ["src/mutation.ts", "src/mutationOps.ts", "src/index.ts"],
    acceptance: {
      typecheck: true,
      test_command: "npx tsx src/cli.ts run-experiment 2",
    },
  },
];

import assert from "node:assert/strict";
import test from "node:test";

import { mutateGenome, randomExplore } from "./mutation.ts";
import { applyOneMutation } from "./mutationOps.ts";
import type { Attempt, MutationEvent, StrategyGenome } from "./types.ts";

function makeGenome(): StrategyGenome {
  return {
    id: "strategy_v1",
    parent_id: null,
    generation: 1,
    status: "active",
    applies_to: {
      goal_pattern: "storage",
      module_region: "mutation and evolution",
      risk_level: "medium",
    },
    context_strategy: {
      read_order: ["scout"],
      max_files: 5,
      scout_first: true,
    },
    action_strategy: {
      patch_granularity: "small",
      prefer_existing_pattern: true,
      forbid_architecture_change: true,
    },
    validation_strategy: {
      required: ["typecheck"],
      optional: [],
    },
    boundary_strategy: {
      allowed_file_policy: "affected_module_only",
      max_diff_lines: 120,
    },
    reward_profile: {
      optimize_for: ["semantic_confidence"],
      punish: ["diff_size"],
    },
    mutation_policy: [],
  };
}

function makeAttempt(): Attempt {
  return {
    id: "attempt_1",
    timestamp: new Date().toISOString(),
    experience_key: {
      goal_pattern: "storage",
      module_region: "mutation and evolution",
      context_shape: ["helper"],
      risk_level: "medium",
    },
    strategy_genome_id: "strategy_v1",
    worker: "codex",
    result: "failure",
    files_changed: ["src/mutation.ts"],
    diff_lines: 12,
    tests_added: 0,
    commands_run: [],
    boundary_violations: [],
    notes: [],
  };
}

test("applyOneMutation records the full updated read order after adding a critical dependency scan", () => {
  const child = makeGenome();
  child.context_strategy.read_order = ["scout", "tests_first"];
  const changed: MutationEvent["mutation"]["changed"] = {};

  applyOneMutation(
    child,
    "context_underread",
    changed,
    [
      {
        ...makeAttempt(),
        diff_lines: 12,
        files_changed: ["src/a.ts", "src/b.ts"],
        boundary_violations: [],
      },
    ],
  );

  assert.deepEqual(child.context_strategy.read_order, ["critical_dependency_scan", "scout", "tests_first"]);
  assert.deepEqual(changed["context_strategy.read_order"], {
    from: ["scout", "tests_first"],
    to: ["critical_dependency_scan", "scout", "tests_first"],
  });
});

test("mutateGenome falls back to a safe mutation type when no mutation handlers run", () => {
  const parent = makeGenome();

  const { event } = mutateGenome(parent, "duplicate_effort", [], 1, ["duplicate_effort"]);

  assert.equal(event.mutation.type, "unknown_mutation");
});

test("randomExplore mutates context_strategy.max_files via the shared getField/setField helpers", () => {
  const parent = makeGenome();
  // Deterministic random: 0.0 picks the first SAFE_RANDOM_RULES entry
  // ({ field: "context_strategy.max_files", delta: 1, min: 2, max: 14 }).
  const result = randomExplore(parent, 7, () => 0);

  assert.ok(result, "randomExplore should produce a child for a valid genome");
  const { child, event } = result;

  // Field actually changed on the child (shared setField from mutationOps reaches the nested path).
  assert.equal(child.context_strategy.max_files, parent.context_strategy.max_files + 1);
  // Parent must not be mutated.
  assert.equal(parent.context_strategy.max_files, 5);

  // Event records the before/after via the field path.
  assert.deepEqual(event.mutation.changed["context_strategy.max_files"], {
    from: 5,
    to: 6,
  });
  assert.equal(event.mutation.type, "random_exploration");
  assert.equal(event.id, "mut_0007");
  assert.equal(child.parent_id, parent.id);
  assert.equal(child.generation, parent.generation + 1);
  assert.equal(child.status, "candidate");
});

import assert from "node:assert/strict";
import test from "node:test";

import { crossover } from "./crossover.ts";
import { applyOneMutation } from "./mutationOps.ts";
import { mutateGenome } from "./mutation.ts";
import type { Attempt, MutationEvent, RewardBundle, StrategyGenome } from "./types.ts";

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
      penalize_for: ["diff_size"],
    },
  };
}

function makeAttempt(): Attempt {
  return {
    id: "attempt_1",
    strategy_genome_id: "strategy_v1",
    timestamp: new Date().toISOString(),
    experience_key: {
      goal_pattern: "storage",
      module_region: "mutation and evolution",
      context_shape: ["helper"],
      risk_level: "medium",
    },
    files_changed: ["src/mutation.ts"],
    diff_lines: 12,
    tests: [],
    result: "fail",
    failure_mode: "missing_test",
    semantic_confidence: {
      score: 0.8,
      reasons: ["needs targeted test"],
    },
    guard_flags: [],
    boundary_violations: [],
    notes: [],
    cost: {
      tokens_in: 10,
      tokens_out: 5,
      wall_ms: 20,
    },
  };
}

test("context_underread mutation records only newly added read step in changed diff", () => {
  const child = makeGenome();
  const changed: MutationEvent["mutation"]["changed"] = {};

  const result = applyOneMutation(child, "context_underread", changed, [makeAttempt()]);

  assert.equal(result.type, "context_expansion");
  assert.deepEqual(changed["context_strategy.read_order"], {
    from: ["scout"],
    to: ["critical_dependency_scan"],
  });
  assert.deepEqual(child.context_strategy.read_order, ["critical_dependency_scan", "scout"]);
});


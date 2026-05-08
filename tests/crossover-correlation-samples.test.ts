// Targeted regression test for src/crossover.ts updateCorrelationMatrix.
//
// Verifies that:
//   1. After a single crossover call, the persisted correlation-matrix.json
//      records sample_count = 1 for fields that differ between parents.
//   2. After a second crossover call on the same root, sample_count
//      accumulates (becomes 2). Previously this stayed at 1 because the
//      sample counts were never loaded back from disk.
//
// Run: tsx tests/crossover-correlation-samples.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { crossover } from "../src/crossover";
import type { RewardBundle, StrategyGenome } from "../src/types";

function makeGenome(overrides: Partial<StrategyGenome> = {}): StrategyGenome {
  return {
    id: "g_a",
    parent_id: null,
    generation: 0,
    status: "active",
    applies_to: { goal_pattern: "fix:bug", module_region: "src/foo" },
    context_strategy: { read_order: ["scout"], max_files: 5, scout_first: false },
    action_strategy: {
      patch_granularity: "small",
      prefer_existing_pattern: true,
      forbid_architecture_change: false,
    },
    validation_strategy: { required: ["typecheck"], optional: [] },
    boundary_strategy: { allowed_file_policy: "any", max_diff_lines: 100 },
    reward_profile: { optimize_for: ["semantic_confidence"], punish: [] },
    mutation_policy: [],
    ...overrides,
  };
}

function makeReward(overrides: Partial<RewardBundle>): RewardBundle {
  return {
    id: "r",
    attempt_id: "a",
    strategy_genome_id: "g_a",
    experience_key_hash: "k",
    reward: 0.5,
    semantic_confidence: { score: 0.7, evidence: [] },
    cost: {
      diff_lines: 20,
      files_changed: 1,
      human_intervention: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
    },
    guard_flags: [],
    failure_mode: "none",
    ...overrides,
  };
}

interface CorrelationRecord {
  field: string;
  reward_correlation: number;
  sample_count: number;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crossover-corr-"));
try {
  // Two parents that differ on context_strategy and boundary_strategy so
  // multiple fields produce a non-null correlation.
  const parentA = makeGenome({
    id: "p_a",
    context_strategy: { read_order: ["scout"], max_files: 5, scout_first: false },
    boundary_strategy: { allowed_file_policy: "any", max_diff_lines: 100 },
  });
  const parentB = makeGenome({
    id: "p_b",
    context_strategy: { read_order: ["scout", "tests_first"], max_files: 8, scout_first: true },
    boundary_strategy: { allowed_file_policy: "affected_module_only", max_diff_lines: 200 },
  });

  // Two rewards per parent (crossover requires >= 2) with different rewards
  // so computeFieldCorrelation returns +1 / -1 (non-null).
  const rewards: RewardBundle[] = [
    makeReward({ id: "r1", attempt_id: "a1", strategy_genome_id: "p_a", reward: 0.9 }),
    makeReward({ id: "r2", attempt_id: "a2", strategy_genome_id: "p_a", reward: 0.85 }),
    makeReward({ id: "r3", attempt_id: "a3", strategy_genome_id: "p_b", reward: 0.4 }),
    makeReward({ id: "r4", attempt_id: "a4", strategy_genome_id: "p_b", reward: 0.45 }),
  ];

  // First crossover — should write sample_count = 1 for fields that differ.
  const first = crossover(parentA, parentB, rewards, "child_v1", tmpRoot);
  assert.ok(first, "first crossover should succeed");

  const matrixPath = path.join(tmpRoot, ".antcode", "correlation-matrix.json");
  assert.ok(fs.existsSync(matrixPath), "correlation-matrix.json should be written");

  const afterFirst = JSON.parse(fs.readFileSync(matrixPath, "utf8")) as CorrelationRecord[];
  const ctxFirst = afterFirst.find((r) => r.field === "context_strategy");
  const bndFirst = afterFirst.find((r) => r.field === "boundary_strategy");
  assert.ok(ctxFirst, "context_strategy correlation should be recorded");
  assert.ok(bndFirst, "boundary_strategy correlation should be recorded");
  assert.equal(ctxFirst!.sample_count, 1, "first call should record sample_count=1 for context_strategy");
  assert.equal(bndFirst!.sample_count, 1, "first call should record sample_count=1 for boundary_strategy");

  // Second crossover — sample_count must accumulate to 2. Previously the
  // count was reset because loadCorrelationMatrix discarded sample_count.
  const second = crossover(parentA, parentB, rewards, "child_v2", tmpRoot);
  assert.ok(second, "second crossover should succeed");

  const afterSecond = JSON.parse(fs.readFileSync(matrixPath, "utf8")) as CorrelationRecord[];
  const ctxSecond = afterSecond.find((r) => r.field === "context_strategy");
  const bndSecond = afterSecond.find((r) => r.field === "boundary_strategy");
  assert.equal(
    ctxSecond!.sample_count,
    2,
    "sample_count should accumulate across crossover calls (was 1 before fix)",
  );
  assert.equal(
    bndSecond!.sample_count,
    2,
    "sample_count should accumulate across crossover calls (was 1 before fix)",
  );
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("crossover correlation-matrix sample_count accumulates across calls");

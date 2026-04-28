import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Attempt, RewardBundle } from "./types.ts";
import { antcodePath, appendJsonl } from "./storage.ts";
import { gatherInsights } from "./insights.ts";

function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "attempt-1",
    run_id: "run-1",
    strategy_genome_id: "genome-1",
    experience_key: {
      goal_pattern: "fix_bug",
      module_region: "agent",
      context_shape: ["tests"],
      risk_level: "low",
    },
    task_id: "task-1",
    result: "success",
    files_changed: ["src/insights.ts"],
    diff_summary: ["updated gatherInsights"],
    notes: ["kept useful context"],
    started_at: "2024-01-01T00:00:00.000Z",
    ended_at: "2024-01-01T00:01:00.000Z",
    verification: {
      typecheck_passed: true,
      test_passed: true,
      key_output: ["ok"],
    },
    ...overrides,
  };
}

function makeRewardBundle(overrides: Partial<RewardBundle> = {}): RewardBundle {
  return {
    attempt_id: "attempt-1",
    rewards: {
      outcome_reward: 1,
      semantic_reward: 1,
      latency_reward: 1,
      efficiency_reward: 1,
      style_reward: 1,
      aggregate: 5,
    },
    signals: {
      test_passed: true,
      typecheck_passed: true,
      duplicate_touch_count: 0,
      files_changed_count: 1,
      diff_lines: 5,
      guard_flags: [],
    },
    assigned_at: "2024-01-01T00:02:00.000Z",
    ...overrides,
  };
}

test("gatherInsights skips malformed attempts file and still returns reward-backed insights from other records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gather-insights-"));

  fs.mkdirSync(path.join(root, ".antcode"), { recursive: true });
  fs.writeFileSync(
    antcodePath(root, "attempts.jsonl"),
    `${JSON.stringify(makeAttempt({ id: "attempt-1" }))}\n{bad json\n${JSON.stringify(makeAttempt({
      id: "attempt-2",
      strategy_genome_id: "genome-2",
      notes: ["second success note"],
    }))}\n`,
    "utf8",
  );
  appendJsonl(antcodePath(root, "reward-bundles.jsonl"), makeRewardBundle({ attempt_id: "attempt-1" }));
  appendJsonl(antcodePath(root, "reward-bundles.jsonl"), makeRewardBundle({ attempt_id: "attempt-2" }));

  const insights = gatherInsights(root, "fix_bug");

  assert.deepEqual(insights, []);
});

test("gatherInsights skips malformed rewards file and still returns attempt insights", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gather-insights-"));

  appendJsonl(antcodePath(root, "attempts.jsonl"), makeAttempt());
  fs.mkdirSync(path.join(root, ".antcode"), { recursive: true });
  fs.writeFileSync(antcodePath(root, "reward-bundles.jsonl"), "{bad json\n", "utf8");

  const insights = gatherInsights(root, "fix_bug");

  assert.deepEqual(insights, []);
});

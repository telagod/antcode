import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gatherInsights } from "./insights.ts";

test("gatherInsights skips unreadable and malformed JSONL entries instead of aborting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "antcode-insights-"));
  const antcodeDir = path.join(root, ".antcode");
  fs.mkdirSync(antcodeDir, { recursive: true });

  fs.writeFileSync(
    path.join(antcodeDir, "attempts.jsonl"),
    [
      JSON.stringify({
        id: "attempt_1",
        timestamp: new Date().toISOString(),
        experience_key: {
          goal_pattern: "mutation",
          module_region: "mutation and evolution",
          context_shape: ["src/insights.ts"],
          risk_level: "medium",
        },
        strategy_genome_id: "genome_ok",
        worker: "mock",
        result: "success",
        files_changed: ["src/insights.ts"],
        diff_lines: 3,
        tests_added: 1,
        commands_run: [],
        boundary_violations: [],
        notes: ["handled malformed jsonl gracefully"],
      }),
      "{not valid json}",
      JSON.stringify({
        id: "attempt_2",
        timestamp: new Date().toISOString(),
        experience_key: {
          goal_pattern: "other",
          module_region: "mutation and evolution",
          context_shape: ["src/other.ts"],
          risk_level: "medium",
        },
        strategy_genome_id: "genome_other",
        worker: "mock",
        result: "failure",
        files_changed: ["src/other.ts"],
        diff_lines: 2,
        tests_added: 0,
        commands_run: [],
        boundary_violations: [],
        notes: ["error in unrelated goal"],
      }),
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(antcodeDir, "reward-bundles.jsonl"),
    [
      JSON.stringify({
        id: "reward_1",
        attempt_id: "attempt_1",
        strategy_genome_id: "genome_ok",
        experience_key_hash: "hash_1",
        reward: 1,
        semantic_confidence: { score: 0.9, evidence: [] },
        cost: {
          diff_lines: 3,
          files_changed: 1,
          human_intervention: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
        },
        guard_flags: [],
        failure_mode: "none",
      }),
      "this is not json",
    ].join("\n"),
    "utf8",
  );

  const insights = gatherInsights(root, "mutation", 5);

  assert.deepEqual(insights, [
    {
      task_goal: "mutation",
      genome_id: "genome_ok",
      what_worked: ["handled malformed jsonl gracefully"],
      what_failed: [],
      files_touched: ["src/insights.ts"],
    },
  ]);
});

test("gatherInsights returns insights when rewards file is unreadable or missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "antcode-insights-"));
  const antcodeDir = path.join(root, ".antcode");
  fs.mkdirSync(antcodeDir, { recursive: true });

  fs.writeFileSync(
    path.join(antcodeDir, "attempts.jsonl"),
    JSON.stringify({
      id: "attempt_1",
      timestamp: new Date().toISOString(),
      experience_key: {
        goal_pattern: "mutation",
        module_region: "mutation and evolution",
        context_shape: ["src/insights.ts"],
        risk_level: "medium",
      },
      strategy_genome_id: "genome_ok",
      worker: "mock",
      result: "success",
      files_changed: ["src/insights.ts"],
      diff_lines: 3,
      tests_added: 1,
      commands_run: [],
      boundary_violations: [],
      notes: ["should not be dropped if rewards file is bad"],
    }),
    "utf8",
  );

  const insights = gatherInsights(root, "mutation", 5);

  assert.deepEqual(insights, []);
});
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

test("gatherInsights skips malformed attempts entries and still returns insights from valid records", () => {
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

  assert.deepEqual(insights, [
    {
      task_goal: "fix_bug",
      genome_id: "genome-1",
      what_worked: ["kept useful context"],
      what_failed: [],
      files_touched: ["src/insights.ts"],
    },
    {
      task_goal: "fix_bug",
      genome_id: "genome-2",
      what_worked: ["second success note"],
      what_failed: [],
      files_touched: ["src/insights.ts"],
    },
  ]);
});

test("gatherInsights skips malformed rewards entries and still returns attempt insights", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gather-insights-"));

  appendJsonl(antcodePath(root, "attempts.jsonl"), makeAttempt());
  fs.mkdirSync(path.join(root, ".antcode"), { recursive: true });
  fs.writeFileSync(
    antcodePath(root, "reward-bundles.jsonl"),
    `${JSON.stringify(makeRewardBundle())}\n{bad json\n`,
    "utf8",
  );

  const insights = gatherInsights(root, "fix_bug");

  assert.deepEqual(insights, [
    {
      task_goal: "fix_bug",
      genome_id: "genome-1",
      what_worked: ["kept useful context"],
      what_failed: [],
      files_touched: ["src/insights.ts"],
    },
  ]);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Attempt, RewardBundle } from "./types.ts";
import { antcodePath, appendJsonl } from "./storage.ts";

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

test("gatherInsights skips malformed rewards file and still returns attempt insights", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gather-insights-"));

  appendJsonl(antcodePath(root, "attempts.jsonl"), makeAttempt());
  fs.mkdirSync(path.join(root, ".antcode"), { recursive: true });
  fs.writeFileSync(antcodePath(root, "reward-bundles.jsonl"), "{bad json\n", "utf8");

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

export interface SharedInsight {
  task_goal: string;
  genome_id: string;
  what_worked: string[];
  what_failed: string[];
  files_touched: string[];
}

export function gatherInsights(root: string, goalPattern: string, limit = 5): SharedInsight[] {
  const attempts = tryReadJsonl<Attempt>(antcodePath(root, "attempts.jsonl"), []).value;
  const rewards = tryReadJsonl<RewardBundle>(antcodePath(root, "reward-bundles.jsonl"), []).value;

  const rewardMap = new Map(rewards.map((r) => [r.attempt_id, r]));
  const relevant = attempts
    .filter((a) => a.experience_key.goal_pattern === goalPattern)
    .slice(-20);

  const successes: SharedInsight[] = [];
  const failures: SharedInsight[] = [];

  for (const a of relevant) {
    const r = rewardMap.get(a.id);
    if (!r) continue;

    if (a.result === "success") {
      successes.push({
        task_goal: goalPattern,
        genome_id: a.strategy_genome_id,
        what_worked: a.notes.filter((n) => !n.startsWith("tokens:")).slice(0, 3),
        what_failed: [],
        files_touched: a.files_changed,
      });
    } else if (a.result === "failure" || a.result === "blocked") {
      failures.push({
        task_goal: goalPattern,
        genome_id: a.strategy_genome_id,
        what_worked: [],
        what_failed: a.notes.filter((n) => !n.startsWith("tokens:") && (n.includes("error") || n.includes("fail") || n.includes("block") || n.includes("exceed"))).slice(0, 2),
        files_touched: a.files_changed,
      });
    }
  }

  return [...successes.slice(-limit), ...failures.slice(-limit)];
}

export function formatInsightsForPrompt(insights: SharedInsight[]): string {
  if (!insights.length) return "";

  const lines: string[] = ["## Prior Attempts (shared knowledge)"];
  const successes = insights.filter((i) => i.what_worked.length > 0);
  const failures = insights.filter((i) => i.what_failed.length > 0);

  if (successes.length) {
    lines.push("\nSuccessful approaches:");
    for (const s of successes.slice(-3)) {
      lines.push(`- ${s.genome_id}: ${s.what_worked.join("; ")} [files: ${s.files_touched.join(", ")}]`);
    }
  }
  if (failures.length) {
    lines.push("\nApproaches that failed (avoid these):");
    for (const f of failures.slice(-3)) {
      lines.push(`- ${f.genome_id}: ${f.what_failed.join("; ")}`);
    }
  }

  return lines.join("\n");
}

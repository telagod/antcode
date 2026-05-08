import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { showGenomes } from "./showGenomes.ts";

function withCapturedTable<T>(fn: () => T): { rowsArg: unknown; called: number; result: T } {
  const original = console.table;
  let called = 0;
  let rowsArg: unknown = undefined;
  console.table = (rows?: unknown) => {
    called++;
    rowsArg = rows;
  };
  try {
    const result = fn();
    return { rowsArg, called, result };
  } finally {
    console.table = original;
  }
}

test("showGenomes reads StrategyGenome rows and prints a flattened table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "show-genomes-"));
  const file = path.join(dir, "strategy-genomes.jsonl");
  // Two rows: one with a parent, one without — exercises the `?? "-"` fallback.
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: "g_root",
      parent_id: null,
      generation: 0,
      status: "active",
      applies_to: { goal_pattern: "fix_type_error" },
      context_strategy: { max_files: 5 },
      action_strategy: { patch_granularity: "small" },
      boundary_strategy: { max_diff_lines: 80 },
    }) + "\n" +
      JSON.stringify({
        id: "g_child",
        parent_id: "g_root",
        generation: 1,
        status: "candidate",
        applies_to: { goal_pattern: "refactor_module" },
        context_strategy: { max_files: 8 },
        action_strategy: { patch_granularity: "medium" },
        boundary_strategy: { max_diff_lines: 200 },
      }) + "\n",
    "utf8",
  );

  const { rowsArg, called } = withCapturedTable(() => showGenomes(file));

  assert.equal(called, 1, "console.table should be invoked exactly once");
  assert.ok(Array.isArray(rowsArg), "console.table should receive an array");
  const rows = rowsArg as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);

  // Row 0: missing parent_id is rendered as "-" (not undefined/null).
  assert.equal(rows[0].id, "g_root");
  assert.equal(rows[0].parent, "-");
  assert.equal(rows[0].gen, 0);
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].goal, "fix_type_error");
  assert.equal(rows[0].maxFiles, 5);
  assert.equal(rows[0].patch, "small");
  assert.equal(rows[0].maxDiff, 80);

  // Row 1: parent_id flows through verbatim.
  assert.equal(rows[1].id, "g_child");
  assert.equal(rows[1].parent, "g_root");
  assert.equal(rows[1].gen, 1);
  assert.equal(rows[1].goal, "refactor_module");
});

test("showGenomes prints an empty table when the genomes file is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "show-genomes-empty-"));
  const file = path.join(dir, "does-not-exist.jsonl");

  const { rowsArg } = withCapturedTable(() => {
    assert.doesNotThrow(() => showGenomes(file));
  });

  assert.ok(Array.isArray(rowsArg));
  assert.equal((rowsArg as unknown[]).length, 0);
});

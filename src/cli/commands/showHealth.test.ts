import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { showHealth } from "./showHealth.ts";

test("showHealth reads ExperienceKeyHealth rows and prints a table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "show-health-"));
  const file = path.join(dir, "experience-key-health.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({
      experience_key_hash: "abc123",
      sample_count: 3,
      transfer_success_rate: 0.5,
      diagnosis: ["noisy_rewards"],
      action: ["increase_samples"],
    }) + "\n",
    "utf8",
  );

  // Capture console.table output so we can assert the command wrote *something*
  // without relying on the exact tabular format (which differs across Node versions).
  const original = console.table;
  let called = 0;
  let rowsArg: unknown = undefined;
  console.table = (rows?: unknown) => {
    called++;
    rowsArg = rows;
  };

  try {
    showHealth(file);
  } finally {
    console.table = original;
  }

  assert.equal(called, 1, "console.table should be invoked exactly once");
  assert.ok(Array.isArray(rowsArg), "console.table should receive an array of rows");
  const arr = rowsArg as Array<Record<string, unknown>>;
  assert.equal(arr.length, 1);
  assert.equal(arr[0].experience_key_hash, "abc123");
  assert.equal(arr[0].sample_count, 3);
  assert.equal(arr[0].diagnosis, "noisy_rewards");
  assert.equal(arr[0].action, "increase_samples");
});

test("showHealth handles an empty/missing health file without throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "show-health-empty-"));
  const file = path.join(dir, "missing.jsonl");

  const original = console.table;
  let rowsArg: unknown = undefined;
  console.table = (rows?: unknown) => {
    rowsArg = rows;
  };

  try {
    assert.doesNotThrow(() => showHealth(file));
  } finally {
    console.table = original;
  }

  assert.ok(Array.isArray(rowsArg));
  assert.equal((rowsArg as unknown[]).length, 0);
});

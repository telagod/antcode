import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gatherInsights } from "./insights.ts";
import { appendJsonl, readJsonl, StorageError, writeJson } from "./storage.ts";
import { mergeFilesToProject, mergeToProject } from "./verify.ts";

test("gatherInsights tolerates malformed or missing insight files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gather-insights-"));
  const antcodeDir = path.join(root, ".antcode");
  fs.mkdirSync(antcodeDir, { recursive: true });

  fs.writeFileSync(path.join(antcodeDir, "attempts.jsonl"), '{"id":"bad"\n', "utf8");

  assert.deepEqual(gatherInsights(root, "goal-a"), []);

  fs.rmSync(path.join(antcodeDir, "attempts.jsonl"));
  appendJsonl(path.join(antcodeDir, "reward-bundles.jsonl"), {
    attempt_id: "attempt-1",
    reward: 0.9,
    components: {
      outcome: 0.9,
      efficiency: 0.8,
      safety: 1,
      novelty: 0.5,
      transfer: 0.5,
    },
    guard_flags: [],
    semantic_confidence: { score: 0.8, evidence: [] },
    failure_mode: "none",
    duplicate_cluster_id: null,
    experience_key_hash: "hash-1",
  });

  assert.deepEqual(gatherInsights(root, "goal-a"), []);
});


try {
  const blockedParent = path.join(tempRoot, "blocked-parent");
  fs.writeFileSync(blockedParent, "not a directory", "utf8");

  assert.throws(
    () => writeJson(path.join(blockedParent, "data.json"), { ok: true }),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "WRITE_PREPARE_FAILED");
      assert.equal(error.operation, "writeJson");
      assert.equal(error.file, path.join(blockedParent, "data.json"));
      assert.match(error.message, /Failed to prepare directory for JSON write/);
      return true;
    },
  );

  const partialJsonlFile = path.join(tempRoot, "partial.jsonl");
  fs.writeFileSync(partialJsonlFile, '{"ok":true}\n{"broken":', "utf8");

  assert.throws(
    () => readJsonl(partialJsonlFile),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "PARSE_FAILED");
      assert.equal(error.operation, "readJsonl");
      assert.equal(error.file, partialJsonlFile);
      assert.equal(error.line, 2);
      assert.equal(error.partial, true);
      assert.match(error.message, /partial or truncated/);
      return true;
    },
  );

  const blockedMergeFilesParent = path.join(tempRoot, "blocked-merge-files-parent");
  fs.writeFileSync(blockedMergeFilesParent, "not a directory", "utf8");

  assert.throws(
    () => mergeFilesToProject({ [path.relative(process.cwd(), path.join(blockedMergeFilesParent, "child.txt"))]: "hello" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to merge file .*child\.txt to .*child\.txt: unable to prepare destination directory .*ENOTDIR/);
      return true;
    },
  );

  test("gatherInsights skips missing and malformed insight files", () => {
    const root = fs.mkdtempSync(path.join(tempRoot, "insights-"));

    assert.deepEqual(gatherInsights(root, "mutation and evolution"), []);

    const antcodeDir = path.join(root, ".antcode");
    fs.mkdirSync(antcodeDir, { recursive: true });
    fs.writeFileSync(path.join(antcodeDir, "attempts.jsonl"), '{"id":"attempt_1","strategy_genome_id":"strategy_v1","timestamp":"2024-01-01T00:00:00.000Z","experience_key":{"goal_pattern":"mutation and evolution","module_region":"mutation and evolution","context_shape":[],"risk_level":"medium"},"result":"success","failure_mode":"none","semantic_confidence":{"score":0.9,"reasoning":["ok"]},"files_changed":["src/mutation.ts"],"diff_lines":10,"boundary_violations":[],"notes":["kept mutation scoped"]}\n{"broken":', "utf8");
    fs.writeFileSync(path.join(antcodeDir, "reward-bundles.jsonl"), '{"attempt_id":"attempt_1","strategy_genome_id":"strategy_v1","reward":1,"failure_mode":"none","semantic_confidence":{"score":0.9,"reasoning":["ok"]},"guard_flags":[],"cost":{"files_changed":1,"diff_lines":10,"validation_minutes":1}}\n', "utf8");

    assert.deepEqual(gatherInsights(root, "mutation and evolution"), []);
  });

} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

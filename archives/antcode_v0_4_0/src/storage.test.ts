import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonl, StorageError, writeJson } from "./storage.ts";
import { mergeFilesToProject, mergeToProject } from "./verify.ts";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-write-json-"));

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

} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

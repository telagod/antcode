import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendJsonl, overwriteJsonl, readJson, readJsonl, StorageError, tryReadJson } from "../src/storage.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-test-"));

try {
  const malformedJsonPath = path.join(tempRoot, "bad.json");
  fs.writeFileSync(malformedJsonPath, "{bad", "utf8");

  assert.throws(
    () => readJson(malformedJsonPath, {}),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "PARSE_FAILED");
      assert.equal(error.operation, "readJson");
      assert.equal(error.file, malformedJsonPath);
      return true;
    },
  );

  const recovered = tryReadJson(malformedJsonPath, { recovered: true });
  assert.deepEqual(recovered, { value: { recovered: true }, found: true });

  const partialJsonlPath = path.join(tempRoot, "partial.jsonl");
  fs.writeFileSync(partialJsonlPath, '{"ok":1}\n{"bad"', "utf8");
  assert.throws(
    () => readJsonl(partialJsonlPath),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "PARSE_FAILED");
      assert.equal(error.operation, "readJsonl");
      assert.equal(error.line, 2);
      assert.equal(error.partial, true);
      return true;
    },
  );

  const occupiedPath = path.join(tempRoot, "occupied");
  fs.writeFileSync(occupiedPath, "file", "utf8");
  const nestedJsonlPath = path.join(occupiedPath, "events.jsonl");

  assert.throws(
    () => appendJsonl(nestedJsonlPath, { event: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "WRITE_PREPARE_FAILED");
      assert.equal(error.operation, "appendJsonl");
      assert.equal(error.file, nestedJsonlPath);
      return true;
    },
  );

  assert.throws(
    () => overwriteJsonl(nestedJsonlPath, [{ event: 1 }]),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "WRITE_PREPARE_FAILED");
      assert.equal(error.operation, "overwriteJsonl");
      assert.equal(error.file, nestedJsonlPath);
      return true;
    },
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

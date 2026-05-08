import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BufferedStorage, StorageError } from "./storage.ts";

test("BufferedStorage.flushFile preserves buffered lines when the write fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buffered-storage-fail-"));
  const target = path.join(root, "events.jsonl");

  // Pre-create a *directory* at the target path so fs.appendFileSync throws
  // EISDIR. This is a deterministic way to provoke a write failure without
  // mocking the fs module.
  fs.mkdirSync(target);

  const storage = new BufferedStorage();
  try {
    storage.appendJsonl(target, { id: 1 });
    storage.appendJsonl(target, { id: 2 });

    // The failing flush must surface a StorageError…
    assert.throws(
      () => storage.flushFile(target),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "WRITE_FAILED" &&
        error.operation === "appendJsonl",
    );

    // …but the buffered records must still be retained for retry rather than
    // being silently dropped.
    fs.rmdirSync(target);
    storage.flushFile(target);

    const lines = fs
      .readFileSync(target, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    assert.deepEqual(lines, ['{"id":1}', '{"id":2}']);
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("BufferedStorage.flushFile clears the buffer after a successful write", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buffered-storage-success-"));
  const target = path.join(root, "events.jsonl");

  const storage = new BufferedStorage();
  try {
    storage.appendJsonl(target, { id: 1 });
    storage.flushFile(target);

    // A second flush with no new data must be a no-op (no duplicate writes
    // and no errors thrown).
    storage.flushFile(target);

    const lines = fs
      .readFileSync(target, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    assert.deepEqual(lines, ['{"id":1}']);
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, readJsonl, StorageError } from "./storage.ts";

test("readJson returns parsed JSON objects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-read-json-"));
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, JSON.stringify({ ok: true, count: 2 }), "utf8");

  const value = readJson(file, { ok: false, count: 0 });

  assert.deepEqual(value, { ok: true, count: 2 });
});

test("readJsonl returns parsed JSONL rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-read-jsonl-"));
  const file = path.join(dir, "data.jsonl");
  fs.writeFileSync(file, '{"id":1}\n{"id":2}\n', "utf8");

  const value = readJsonl(file);

  assert.deepEqual(value, [{ id: 1 }, { id: 2 }]);
});

test("readJson rejects non-JSON parsed values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-non-json-"));
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, "0", "utf8");

  const originalParse = JSON.parse;
  JSON.parse = () => undefined as never;

  try {
    assert.throws(
      () => readJson(file, 1),
      (error: unknown) => error instanceof StorageError && error.code === "PARSE_FAILED",
    );
  } finally {
    JSON.parse = originalParse;
  }
});

test("readJsonl rejects non-JSON parsed rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-jsonl-non-json-"));
  const file = path.join(dir, "data.jsonl");
  fs.writeFileSync(file, '{"id":1}\n', "utf8");

  const originalParse = JSON.parse;
  JSON.parse = () => undefined as never;

  try {
    assert.throws(
      () => readJsonl(file),
      (error: unknown) => error instanceof StorageError && error.code === "PARSE_FAILED",
    );
  } finally {
    JSON.parse = originalParse;
  }
});

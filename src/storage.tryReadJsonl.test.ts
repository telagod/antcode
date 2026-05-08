import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tryReadJson, tryReadJsonl } from "./storage.ts";

test("tryReadJson falls back when the target path cannot be read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-try-read-json-"));
  const blockedPath = path.join(root, "blocked.json");
  fs.mkdirSync(blockedPath);

  const result = tryReadJson(blockedPath, { ok: true });

  assert.deepEqual(result, {
    value: { ok: true },
    found: true,
  });
});

test("tryReadJson falls back when the target file contains malformed JSON", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-try-read-json-malformed-"));
  const file = path.join(root, "bad.json");
  fs.writeFileSync(file, "{not json}", "utf8");

  const result = tryReadJson(file, { ok: true });

  assert.deepEqual(result, {
    value: { ok: true },
    found: true,
  });
});

test("tryReadJsonl falls back when the target path cannot be read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-try-read-jsonl-"));
  const blockedPath = path.join(root, "blocked.jsonl");
  fs.mkdirSync(blockedPath);

  const result = tryReadJsonl(blockedPath, [{ ok: true }]);

  assert.deepEqual(result, {
    value: [{ ok: true }],
    found: true,
  });
});

test("tryReadJsonl falls back when the target file contains malformed JSONL", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-try-read-jsonl-malformed-"));
  const file = path.join(root, "bad.jsonl");
  fs.writeFileSync(file, '{"ok":true}\n{not json}\n', "utf8");

  const result = tryReadJsonl(file, [{ ok: false }]);

  // tryReadJsonl wraps the strict readJsonl: any parse failure surfaces as
  // PARSE_FAILED, and tryReadJsonl returns the fallback (file still found).
  assert.deepEqual(result, {
    value: [{ ok: false }],
    found: true,
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tryReadJsonl } from "./storage.ts";

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

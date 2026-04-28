import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createLocalOps, ALL_TOOLS } from "../src/tools/index.js";
import { cleanupSlot, createSlot, getActiveSlotCount, getProjectRoot } from "../src/verify.js";

const projectRoot = getProjectRoot();
const slot = createSlot(9001);
try {
  assert.ok(slot.includes(path.join(".antcode", "workbenches", "slot_9001")));
  assert.equal(getActiveSlotCount(), 1);
  assert.ok(fs.existsSync(path.join(slot, "src")));

  const bash = ALL_TOOLS.find((tool) => tool.name === "bash");
  assert.ok(bash, "bash tool should exist");
  const blocked = bash.execute(
    { command: "npm run run-experiment -- 1 --real --no-auto-merge" },
    createLocalOps(slot),
    slot,
  );
  assert.match(blocked, /blocked: nested real AntCode runs/);
} finally {
  cleanupSlot(slot);
  fs.rmSync(path.join(projectRoot, ".antcode", "workbenches", "slot_9001"), { recursive: true, force: true });
}

assert.equal(getActiveSlotCount(), 0);
console.log("workbench guard blocks nested real runs");

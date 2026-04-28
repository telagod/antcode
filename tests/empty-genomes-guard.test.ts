import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const stateDir = path.resolve(".antcode");
const backupDir = path.resolve(`.antcode.__empty_guard_backup_${Date.now()}`);
let hadState = false;

try {
  if (fs.existsSync(stateDir)) {
    hadState = true;
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.renameSync(stateDir, backupDir);
  }
  fs.mkdirSync(stateDir, { recursive: true });

  const output = execFileSync("npx", ["tsx", "src/cli.ts", "run-experiment", "1"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15000,
  });

  assert.match(output, /No strategy genomes found/);
  assert.equal(fs.existsSync(path.join(stateDir, "workbenches")), false, "empty state should not create workbenches");
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (hadState) fs.renameSync(backupDir, stateDir);
}

console.log("empty genome state fails fast without workbench churn");

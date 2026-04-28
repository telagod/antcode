import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  approvePatchArtifact,
  createPatchArtifact,
  getProjectRoot,
  rejectPatchArtifact,
  rollbackPatchArtifact,
} from "../src/verify.js";

const projectRoot = getProjectRoot();
const tempSlot = fs.mkdtempSync(path.join(os.tmpdir(), "antcode-artifact-slot-"));
const relFile = "tests/__artifact_lifecycle_tmp.txt";
const projectFile = path.join(projectRoot, relFile);
const artifactsToClean: string[] = [];

try {
  fs.mkdirSync(path.dirname(path.join(tempSlot, relFile)), { recursive: true });
  fs.writeFileSync(path.join(tempSlot, relFile), "artifact lifecycle\n", "utf8");

  const artifact = createPatchArtifact(tempSlot, "attempt_artifact_lifecycle", [relFile], ["test artifact"], ["verify ok"]);
  artifactsToClean.push(artifact.id);
  assert.equal(artifact.status, "pending_review");

  const approved = approvePatchArtifact(artifact.id);
  assert.equal(approved.status, "merged");
  assert.equal(fs.readFileSync(projectFile, "utf8"), "artifact lifecycle\n");

  const rolledBack = rollbackPatchArtifact(artifact.id);
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(fs.existsSync(projectFile), false);

  const rejectRelFile = "tests/__artifact_reject_tmp.txt";
  fs.mkdirSync(path.dirname(path.join(tempSlot, rejectRelFile)), { recursive: true });
  fs.writeFileSync(path.join(tempSlot, rejectRelFile), "reject lifecycle\n", "utf8");
  const rejectedArtifact = createPatchArtifact(tempSlot, "attempt_artifact_reject", [rejectRelFile], ["reject artifact"]);
  artifactsToClean.push(rejectedArtifact.id);
  const rejected = rejectPatchArtifact(rejectedArtifact.id);
  assert.equal(rejected.status, "rejected");
  assert.equal(fs.existsSync(path.join(projectRoot, rejectRelFile)), false);
} finally {
  fs.rmSync(tempSlot, { recursive: true, force: true });
  fs.rmSync(projectFile, { force: true });
  fs.rmSync(path.join(projectRoot, "tests/__artifact_reject_tmp.txt"), { force: true });
  for (const id of artifactsToClean) {
    fs.rmSync(path.join(projectRoot, ".antcode/artifacts", id), { recursive: true, force: true });
  }
}

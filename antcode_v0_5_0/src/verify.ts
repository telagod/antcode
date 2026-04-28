import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PatchArtifactManifest } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WORKBENCH_BASE = path.resolve(PROJECT_ROOT, "..");
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, ".antcode", "artifacts");

interface ArtifactBackupEntry {
  file: string;
  existed: boolean;
}

export interface VerifyResult {
  patch_applied: boolean;
  typecheck_passed: boolean;
  test_passed: boolean | null;
  files_changed: string[];
  diff_lines: number;
  errors: string[];
  notes: string[];
}

let baselineErrorsBySlot = new Map<string, number>();

function countTsErrors(output: string): number {
  return output.split("\n").filter((l: string) => l.includes("error TS")).length;
}


export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

function formatExecError(context: string, error: unknown): string {
  const e = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
  const stderr = e.stderr?.toString().trim();
  const stdout = e.stdout?.toString().trim();
  const detail = stderr || stdout || e.message || String(error);
  return `${context}: ${detail}`;
}

function formatFsError(context: string, error: unknown): string {
  return `${context}: ${(error as Error).message}`;
}

function pathExists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function ensureDirectoryExists(targetPath: string, context: string): void {
  if (!pathExists(targetPath)) {
    throw new Error(`${context}: directory does not exist at ${targetPath}`);
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(targetPath);
  } catch (e) {
    throw new Error(formatFsError(`${context}: unable to stat ${targetPath}`, e));
  }

  if (!stats.isDirectory()) {
    throw new Error(`${context}: expected directory at ${targetPath}`);
  }
}

function ensureFileExists(targetPath: string, context: string): void {
  if (!pathExists(targetPath)) {
    throw new Error(`${context}: file does not exist at ${targetPath}`);
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(targetPath);
  } catch (e) {
    throw new Error(formatFsError(`${context}: unable to stat ${targetPath}`, e));
  }

  if (!stats.isFile()) {
    throw new Error(`${context}: expected file at ${targetPath}`);
  }
}

export function createSlot(slotId: number): string {
  const dir = path.join(WORKBENCH_BASE, `workbench_${slotId}`);
  const base = path.join(WORKBENCH_BASE, "workbench");

  // always start fresh
  if (pathExists(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      throw new Error(formatFsError(`Failed to create slot ${slotId}: unable to remove existing directory ${dir}`, e));
    }

    if (pathExists(dir)) {
      throw new Error(`Failed to create slot ${slotId}: existing directory still present at ${dir}`);
    }
  }

  ensureDirectoryExists(base, `Failed to create slot ${slotId}: base workbench`);

  try {
    execSync(`cp -r "${base}" "${dir}"`, { stdio: "pipe" });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    throw new Error(formatExecError(`Failed to create slot ${slotId}`, e));
  }

  ensureDirectoryExists(dir, `Failed to create slot ${slotId}: destination directory was not created`);
  ensureDirectoryExists(path.join(dir, "src"), `Failed to create slot ${slotId}: source tree was not copied`);

  return dir;
}

export function resetSlot(slot: string): void {
  const src = path.join(PROJECT_ROOT, "src");
  const dst = path.join(slot, "src");

  ensureDirectoryExists(src, `Failed to reset slot ${slot}: source directory`);
  ensureDirectoryExists(slot, `Failed to reset slot ${slot}: slot directory`);

  try {
    fs.rmSync(dst, { recursive: true, force: true });
  } catch (e) {
    throw new Error(formatFsError(`Failed to reset slot ${slot}: unable to remove destination ${dst}`, e));
  }

  if (pathExists(dst)) {
    throw new Error(`Failed to reset slot ${slot}: destination still exists after removal at ${dst}`);
  }

  try {
    fs.cpSync(src, dst, { recursive: true });
  } catch (e) {
    try {
      fs.rmSync(dst, { recursive: true, force: true });
    } catch {
      // best-effort cleanup after partial copy failure
    }
    throw new Error(formatFsError(`Failed to reset slot ${slot} from ${src} to ${dst}`, e));
  }

  ensureDirectoryExists(dst, `Failed to reset slot ${slot}: destination directory was not created`);
}

export function cleanupSlot(slot: string): void {
  baselineErrorsBySlot.delete(slot);
  if (!pathExists(slot)) {
    return;
  }

  ensureDirectoryExists(slot, `Failed to cleanup slot ${slot}`);

  try {
    fs.rmSync(slot, { recursive: true, force: true });
  } catch (e) {
    throw new Error(formatFsError(`Failed to cleanup slot ${slot}`, e));
  }

  if (pathExists(slot)) {
    throw new Error(`Failed to cleanup slot ${slot}: directory still exists at ${slot}`);
  }
}

export function readSlotFile(slot: string, relPath: string): string | null {
  const full = path.join(slot, relPath);
  if (!pathExists(full)) return null;

  try {
    return fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

function applyFileWrites(slot: string, fileWrites: Record<string, string>): { applied: string[]; errors: string[] } {
  const applied: string[] = [];
  const errors: string[] = [];
  for (const [relPath, content] of Object.entries(fileWrites)) {
    try {
      const full = path.join(slot, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
      const written = fs.readFileSync(full, "utf8");
      if (written !== content) {
        throw new Error(`content mismatch after write to ${full}`);
      }
      applied.push(relPath);
    } catch (e) {
      errors.push(formatFsError(`write_failed:${slot}:${relPath}`, e));
    }
  }
  return { applied, errors };
}

function countDiffLines(slot: string, files: string[]): number {
  let total = 0;
  for (const f of files) {
    const projectFile = path.join(PROJECT_ROOT, f);
    const slotFile = path.join(slot, f);
    try {
      if (!pathExists(projectFile) && pathExists(slotFile)) {
        total += fs.readFileSync(slotFile, "utf8").split("\n").length;
        continue;
      }
      const out = execSync(`git diff --no-index -- "${projectFile}" "${slotFile}" | tail -n +5`, {
        stdio: "pipe"
      }).toString();
      total += out.split("\n").filter((l: string) => l.startsWith("+") || l.startsWith("-")).length;
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      const out = err.stdout?.toString() ?? err.stderr?.toString() ?? "";
      if (out) {
        total += out
          .split("\n")
          .slice(4)
          .filter((l: string) => l.startsWith("+") || l.startsWith("-")).length;
      } else {
        total += 999;
      }
    }
  }
  return total;
}

function diffForFile(slot: string, relPath: string): string {
  const projectFile = path.join(PROJECT_ROOT, relPath);
  const slotFile = path.join(slot, relPath);
  if (!pathExists(projectFile) && pathExists(slotFile)) {
    const content = fs.readFileSync(slotFile, "utf8");
    const lines = content.split("\n").map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${relPath} b/${relPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relPath}`,
      "@@",
      lines,
    ].join("\n");
  }
  try {
    return execSync(`git diff --no-index -- "${projectFile}" "${slotFile}"`, {
      stdio: "pipe",
    }).toString();
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return err.stdout?.toString() ?? err.stderr?.toString() ?? "";
  }
}

function safeArtifactId(attemptId: string): string {
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  return `${attemptId}-${suffix}`;
}

function artifactDirFor(id: string): string {
  return path.join(ARTIFACTS_DIR, id);
}

function manifestPathFor(id: string): string {
  return path.join(artifactDirFor(id), "manifest.json");
}

function writePatchArtifactManifest(manifest: PatchArtifactManifest): void {
  fs.writeFileSync(manifestPathFor(manifest.id), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function createPatchArtifact(
  slot: string,
  attemptId: string,
  files: string[],
  notes: string[],
  verificationLines: string[] = [],
): PatchArtifactManifest {
  ensureDirectoryExists(slot, `Failed to create patch artifact for ${attemptId}: slot directory`);
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const id = safeArtifactId(attemptId);
  const artifactDir = path.join(ARTIFACTS_DIR, id);
  const filesDir = path.join(artifactDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });

  const patchText = files.map((file) => diffForFile(slot, file)).filter(Boolean).join("\n");
  const patchFile = path.join(artifactDir, "patch.diff");
  fs.writeFileSync(patchFile, patchText, "utf8");

  for (const file of files) {
    const src = path.join(slot, file);
    if (!pathExists(src)) continue;
    const dst = path.join(filesDir, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  const verificationLog = path.join(artifactDir, "verification.log");
  fs.writeFileSync(verificationLog, verificationLines.join("\n\n"), "utf8");

  const manifest: PatchArtifactManifest = {
    id,
    attempt_id: attemptId,
    created_at: new Date().toISOString(),
    files_changed: files,
    diff_lines: countDiffLines(slot, files),
    patch_file: path.relative(PROJECT_ROOT, patchFile),
    files_dir: path.relative(PROJECT_ROOT, filesDir),
    verification_log: path.relative(PROJECT_ROOT, verificationLog),
    status: "pending_review",
    notes,
  };

  writePatchArtifactManifest(manifest);
  return manifest;
}

export function listPatchArtifacts(): PatchArtifactManifest[] {
  if (!pathExists(ARTIFACTS_DIR)) return [];
  const manifests: PatchArtifactManifest[] = [];
  for (const entry of fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(ARTIFACTS_DIR, entry.name, "manifest.json");
    if (!pathExists(manifestPath)) continue;
    try {
      manifests.push(JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PatchArtifactManifest);
    } catch {
      // Ignore malformed artifact manifests; review command should stay usable.
    }
  }
  return manifests.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getPatchArtifact(idOrAttemptId: string): PatchArtifactManifest | undefined {
  const artifacts = listPatchArtifacts();
  return artifacts.find((a) => a.id === idOrAttemptId)
    ?? artifacts.filter((a) => a.attempt_id === idOrAttemptId).at(-1);
}

export function approvePatchArtifact(idOrAttemptId: string): PatchArtifactManifest {
  const manifest = getPatchArtifact(idOrAttemptId);
  if (!manifest) throw new Error(`No patch artifact found for ${idOrAttemptId}`);
  if (manifest.status !== "pending_review") {
    throw new Error(`Patch artifact ${manifest.id} is ${manifest.status}, not pending_review`);
  }

  const artifactDir = artifactDirFor(manifest.id);
  const filesDir = path.join(PROJECT_ROOT, manifest.files_dir);
  ensureDirectoryExists(filesDir, `Failed to approve artifact ${manifest.id}: files directory`);

  const backupDir = path.join(artifactDir, "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupEntries: ArtifactBackupEntry[] = [];

  for (const relPath of manifest.files_changed) {
    const src = path.join(filesDir, relPath);
    const dst = path.join(PROJECT_ROOT, relPath);
    ensureFileExists(src, `Failed to approve artifact ${manifest.id}: artifact file ${relPath}`);

    if (pathExists(dst)) {
      const backupFile = path.join(backupDir, relPath);
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      fs.copyFileSync(dst, backupFile);
      backupEntries.push({ file: relPath, existed: true });
    } else {
      backupEntries.push({ file: relPath, existed: false });
    }

    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  fs.writeFileSync(path.join(backupDir, "backup-manifest.json"), JSON.stringify(backupEntries, null, 2) + "\n", "utf8");
  manifest.status = "merged";
  manifest.approved_at = new Date().toISOString();
  manifest.backup_dir = path.relative(PROJECT_ROOT, backupDir);
  manifest.notes = [...manifest.notes, "approved and merged to project source"];
  writePatchArtifactManifest(manifest);
  return manifest;
}

export function rejectPatchArtifact(idOrAttemptId: string): PatchArtifactManifest {
  const manifest = getPatchArtifact(idOrAttemptId);
  if (!manifest) throw new Error(`No patch artifact found for ${idOrAttemptId}`);
  if (manifest.status !== "pending_review") {
    throw new Error(`Patch artifact ${manifest.id} is ${manifest.status}, not pending_review`);
  }
  manifest.status = "rejected";
  manifest.rejected_at = new Date().toISOString();
  manifest.notes = [...manifest.notes, "rejected during review"];
  writePatchArtifactManifest(manifest);
  return manifest;
}

export function rollbackPatchArtifact(idOrAttemptId: string): PatchArtifactManifest {
  const manifest = getPatchArtifact(idOrAttemptId);
  if (!manifest) throw new Error(`No patch artifact found for ${idOrAttemptId}`);
  if (manifest.status !== "merged") {
    throw new Error(`Patch artifact ${manifest.id} is ${manifest.status}, not merged`);
  }
  if (!manifest.backup_dir) {
    throw new Error(`Patch artifact ${manifest.id} has no backup_dir; cannot rollback safely`);
  }

  const backupDir = path.join(PROJECT_ROOT, manifest.backup_dir);
  const backupManifestPath = path.join(backupDir, "backup-manifest.json");
  ensureFileExists(backupManifestPath, `Failed to rollback artifact ${manifest.id}: backup manifest`);
  const backupEntries = JSON.parse(fs.readFileSync(backupManifestPath, "utf8")) as ArtifactBackupEntry[];

  for (const entry of backupEntries) {
    const dst = path.join(PROJECT_ROOT, entry.file);
    if (entry.existed) {
      const backupFile = path.join(backupDir, entry.file);
      ensureFileExists(backupFile, `Failed to rollback artifact ${manifest.id}: backup file ${entry.file}`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(backupFile, dst);
    } else if (pathExists(dst)) {
      fs.rmSync(dst, { force: true });
    }
  }

  manifest.status = "rolled_back";
  manifest.rolled_back_at = new Date().toISOString();
  manifest.notes = [...manifest.notes, "rolled back from approval backup"];
  writePatchArtifactManifest(manifest);
  return manifest;
}

function runTypecheck(slot: string): { passed: boolean; output: string; errorCount: number } {
  try {
    const out = execSync("npx tsc --noEmit 2>&1", { cwd: slot, stdio: "pipe", timeout: 30000 }).toString();
    return { passed: true, output: out, errorCount: 0 };
  } catch (e) {
    const error = e as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer };
    const output = error.stdout?.toString()
      ?? error.stderr?.toString()
      ?? error.message;

    if (typeof error.code === "string" || typeof error.code === "number") {
      return { passed: false, output, errorCount: countTsErrors(output) };
    }

    throw new Error(formatFsError(`Failed to run typecheck in slot ${slot}`, e));
  }
}

function runTestCommand(slot: string, cmd: string): { passed: boolean; output: string } {
  try {
    const out = execSync(cmd + " 2>&1", { cwd: slot, stdio: "pipe", timeout: 30000 }).toString();
    return { passed: true, output: out };
  } catch (e) {
    const output = (e as { stdout?: Buffer; stderr?: Buffer }).stdout?.toString()
      ?? (e as { stdout?: Buffer; stderr?: Buffer }).stderr?.toString()
      ?? (e as Error).message;
    return { passed: false, output };
  }
}

export function captureBaseline(slot: string): void {
  ensureDirectoryExists(slot, `Failed to capture baseline for slot ${slot}: slot directory`);

  try {
    const tc = runTypecheck(slot);
    baselineErrorsBySlot.set(slot, tc.errorCount);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to capture baseline for slot ${slot}: unable to run typecheck: ${detail}`);
  }
}

export function verifyPatch(
  slot: string,
  fileWrites: Record<string, string>,
  testCommand?: string
): VerifyResult {
  const result: VerifyResult = {
    patch_applied: false,
    typecheck_passed: false,
    test_passed: null,
    files_changed: [],
    diff_lines: 0,
    errors: [],
    notes: []
  };

  try {
    ensureDirectoryExists(slot, `verify_failed:${slot}: slot directory`);

    const requestedFiles = Object.keys(fileWrites);
    const applied = applyFileWrites(slot, fileWrites);
    result.patch_applied = applied.applied.length > 0;
    result.files_changed = applied.applied;
    result.errors.push(...applied.errors);

    const unapplied = requestedFiles.filter((file) => !applied.applied.includes(file));
    if (unapplied.length > 0) {
      result.errors.push(`patch_apply_incomplete:${slot}:${unapplied.join(",")}`);
    }

    if (requestedFiles.length > 0 && applied.applied.length === 0) {
      result.errors.push(`patch_apply_failed:${slot}:no files were written`);
    }

    result.diff_lines = countDiffLines(slot, applied.applied);

    const tc = runTypecheck(slot);
    const baselineErrors = baselineErrorsBySlot.get(slot) ?? 0;
    const newErrors = tc.errorCount - baselineErrors;
    result.typecheck_passed = newErrors <= 0;
    if (!result.typecheck_passed) {
      const lines = tc.output.split("\n").filter((l: string) => l.includes("error TS")).slice(0, 5);
      result.errors.push(...lines.map((line) => `typecheck_failed:${slot}:${line}`));
    }

    if (testCommand) {
      const test = runTestCommand(slot, testCommand);
      result.test_passed = test.passed;
      if (!test.passed) {
        result.errors.push(`test_failed:${slot}:${testCommand}:`);
        result.errors.push(test.output.split("\n").slice(0, 10).join("\n"));
      }
    }

    return result;
  } catch (e) {
    result.errors.push(formatFsError(`verify_failed:${slot}`, e));
    return result;
  } finally {
    try {
      cleanupSlot(slot);
    } catch (e) {
      result.errors.push(formatFsError(`cleanup_failed:${slot}`, e));
    }
  }
}

export function mergeToProject(slot: string, files: string[]): void {
  ensureDirectoryExists(slot, `Failed to merge from slot ${slot}: slot directory`);

  for (const f of files) {
    const src = path.join(slot, f);
    const dst = path.join(PROJECT_ROOT, f);

    ensureFileExists(src, `Failed to merge file ${f} from slot ${slot}: source file`);

    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch (e) {
      throw new Error(formatFsError(`Failed to merge file ${f} from ${src} to ${dst}`, e));
    }

    ensureFileExists(dst, `Failed to merge file ${f} from ${src} to ${dst}: destination file`);
  }
}

export function mergeFilesToProject(fileContents: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(fileContents)) {
    const dst = path.join(PROJECT_ROOT, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content, "utf8");
    const written = fs.readFileSync(dst, "utf8");
    if (written !== content) {
      throw new Error(`Failed to merge file ${relPath} to ${dst}: content mismatch after write`);
    }
  }
}

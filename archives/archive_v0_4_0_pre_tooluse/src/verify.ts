import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WORKBENCH_BASE = path.resolve(PROJECT_ROOT, "..");

export interface VerifyResult {
  patch_applied: boolean;
  typecheck_passed: boolean;
  test_passed: boolean | null;
  files_changed: string[];
  diff_lines: number;
  errors: string[];
  notes: string[];
}

let baselineErrors: number | null = null;

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

export function createSlot(slotId: number): string {
  const dir = path.join(WORKBENCH_BASE, `workbench_${slotId}`);
  const base = path.join(WORKBENCH_BASE, "workbench");

  // always start fresh
  if (pathExists(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (!pathExists(base)) {
    throw new Error(`Failed to create slot ${slotId}: base workbench does not exist at ${base}`);
  }

  try {
    execSync(`cp -r "${base}" "${dir}"`, { stdio: "pipe" });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    throw new Error(formatExecError(`Failed to create slot ${slotId}`, e));
  }

  return dir;
}

export function resetSlot(slot: string): void {
  const src = path.join(PROJECT_ROOT, "src");
  const dst = path.join(slot, "src");

  if (!pathExists(src)) {
    throw new Error(`Failed to reset slot ${slot}: source directory does not exist at ${src}`);
  }

  try {
    fs.rmSync(dst, { recursive: true, force: true });
  } catch (e) {
    throw new Error(formatFsError(`Failed to reset slot ${slot}: unable to remove destination ${dst}`, e));
  }

  try {
    fs.mkdirSync(slot, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  } catch (e) {
    try {
      fs.rmSync(dst, { recursive: true, force: true });
    } catch {
      // best-effort cleanup after partial copy failure
    }
    throw new Error(formatFsError(`Failed to reset slot ${slot} from ${src} to ${dst}`, e));
  }
}

export function cleanupSlot(slot: string): void {
  if (!pathExists(slot)) {
    return;
  }

  try {
    fs.rmSync(slot, { recursive: true, force: true });
  } catch (e) {
    throw new Error(formatFsError(`Failed to cleanup slot ${slot}`, e));
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

function countTsErrors(output: string): number {
  return output.split("\n").filter((l: string) => l.includes("error TS")).length;
}

function runTypecheck(slot: string): { passed: boolean; output: string; errorCount: number } {
  try {
    const out = execSync("npx tsc --noEmit 2>&1", { cwd: slot, stdio: "pipe", timeout: 30000 }).toString();
    return { passed: true, output: out, errorCount: 0 };
  } catch (e) {
    const output = (e as { stdout?: Buffer; stderr?: Buffer }).stdout?.toString()
      ?? (e as { stdout?: Buffer; stderr?: Buffer }).stderr?.toString()
      ?? (e as Error).message;
    return { passed: false, output, errorCount: countTsErrors(output) };
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
  const tc = runTypecheck(slot);
  baselineErrors = tc.errorCount;
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
    const applied = applyFileWrites(slot, fileWrites);
    result.patch_applied = applied.applied.length > 0;
    result.files_changed = applied.applied;
    result.errors.push(...applied.errors);
    result.diff_lines = countDiffLines(slot, applied.applied);

    const tc = runTypecheck(slot);
    const newErrors = tc.errorCount - (baselineErrors ?? 0);
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
  for (const f of files) {
    const src = path.join(slot, f);
    const dst = path.join(PROJECT_ROOT, f);

    if (!pathExists(src)) {
      throw new Error(`Failed to merge file ${f} from slot ${slot}: source file does not exist at ${src}`);
    }

    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch (e) {
      throw new Error(formatFsError(`Failed to merge file ${f} from ${src} to ${dst}`, e));
    }
  }
}

export function mergeFilesToProject(fileContents: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(fileContents)) {
    const dst = path.join(PROJECT_ROOT, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content, "utf8");
  }
}

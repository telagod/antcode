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

export function createSlot(slotId: number): string {
  const dir = path.join(WORKBENCH_BASE, `workbench_${slotId}`);
  if (!fs.existsSync(dir)) {
    const base = path.join(WORKBENCH_BASE, "workbench");
    execSync(`cp -r "${base}" "${dir}"`, { stdio: "pipe" });
  }
  return dir;
}

export function resetSlot(slot: string): void {
  const src = path.join(PROJECT_ROOT, "src");
  const dst = path.join(slot, "src");
  execSync(`rm -rf "${dst}" && cp -r "${src}" "${dst}"`, { stdio: "pipe" });
}

export function cleanupSlot(slot: string): void {
  if (fs.existsSync(slot) && slot.includes("workbench_")) {
    execSync(`rm -rf "${slot}"`, { stdio: "pipe" });
  }
}

export function readSlotFile(slot: string, relPath: string): string | null {
  const full = path.join(slot, relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}
// VERIFY_P2_PLACEHOLDER

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
      errors.push(`write ${relPath}: ${(e as Error).message}`);
    }
  }
  return { applied, errors };
}

function countDiffLines(slot: string, files: string[]): number {
  let total = 0;
  for (const f of files) {
    try {
      total += fs.readFileSync(path.join(slot, f), "utf8").split("\n").length;
    } catch { /* skip */ }
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
    const output = (e as { stdout?: Buffer; stderr?: Buffer }).stdout?.toString() ?? (e as Error).message;
    return { passed: false, output, errorCount: countTsErrors(output) };
  }
}

function runTestCommand(slot: string, cmd: string): { passed: boolean; output: string } {
  try {
    const out = execSync(cmd + " 2>&1", { cwd: slot, stdio: "pipe", timeout: 30000 }).toString();
    return { passed: true, output: out };
  } catch (e) {
    const output = (e as { stdout?: Buffer; stderr?: Buffer }).stdout?.toString() ?? (e as Error).message;
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
  testCommand?: string,
): VerifyResult {
  const result: VerifyResult = {
    patch_applied: false,
    typecheck_passed: false,
    test_passed: null,
    files_changed: [],
    diff_lines: 0,
    errors: [],
    notes: [],
  };

  const { applied, errors } = applyFileWrites(slot, fileWrites);
  result.files_changed = applied;
  result.errors.push(...errors);

  if (applied.length === 0) {
    result.notes.push("no files were written");
    return result;
  }

  result.patch_applied = true;
  result.diff_lines = countDiffLines(slot, applied);
  result.notes.push(`wrote ${applied.length} file(s)`);

  const tc = runTypecheck(slot);
  const newErrors = tc.errorCount - (baselineErrors ?? 0);
  result.typecheck_passed = newErrors <= 0;
  if (!result.typecheck_passed) {
    const lines = tc.output.split("\n").filter((l: string) => l.includes("error TS")).slice(0, 5);
    result.errors.push(...lines);
    result.notes.push(`typecheck: ${newErrors} new error(s) (baseline: ${baselineErrors ?? 0})`);
  } else {
    result.notes.push(`typecheck passed (${tc.errorCount} pre-existing, 0 new)`);
  }

  if (testCommand) {
    const test = runTestCommand(slot, testCommand);
    result.test_passed = test.passed;
    result.notes.push(test.passed ? `test passed: ${testCommand}` : `test failed: ${testCommand}`);
    if (!test.passed) result.errors.push(test.output.slice(0, 300));
  }

  return result;
}

export function mergeToProject(slot: string, files: string[]): void {
  for (const f of files) {
    const src = path.join(slot, f);
    const dst = path.join(PROJECT_ROOT, f);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

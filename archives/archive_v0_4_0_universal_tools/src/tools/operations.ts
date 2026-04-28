import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// === Operations Interfaces — swap these for remote/docker/ssh backends ===

export interface ReadOps {
  readFile(absPath: string): string | null;
  exists(absPath: string): boolean;
}

export interface WriteOps {
  writeFile(absPath: string, content: string): void;
  mkdir(dir: string): void;
}

export interface EditOps extends ReadOps, WriteOps {}

export interface BashOps {
  exec(command: string, cwd: string, timeout?: number): { exitCode: number; stdout: string; stderr: string };
}

export interface GrepOps {
  grep(pattern: string, cwd: string, opts?: { glob?: string; ignoreCase?: boolean; context?: number; limit?: number }): string;
}

export interface FindOps {
  find(pattern: string, cwd: string, opts?: { limit?: number }): string[];
}

export interface LsOps {
  ls(absPath: string): string[];
}

export interface AllOps extends ReadOps, WriteOps, EditOps, BashOps, GrepOps, FindOps, LsOps {}

// === Default local implementations ===

export function createLocalOps(workDir: string): AllOps {
  return {
    readFile(absPath: string): string | null {
      try { return fs.readFileSync(absPath, "utf8"); } catch { return null; }
    },
    exists(absPath: string): boolean {
      try { return fs.existsSync(absPath); } catch { return false; }
    },
    writeFile(absPath: string, content: string): void {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, "utf8");
    },
    mkdir(dir: string): void {
      fs.mkdirSync(dir, { recursive: true });
    },
// OPS_PART2
    exec(command: string, cwd: string, timeout = 30000): { exitCode: number; stdout: string; stderr: string } {
      try {
        const stdout = execSync(command, { cwd, stdio: "pipe", timeout }).toString();
        return { exitCode: 0, stdout, stderr: "" };
      } catch (e) {
        const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
        return {
          exitCode: err.status ?? 1,
          stdout: err.stdout?.toString() ?? "",
          stderr: err.stderr?.toString() ?? "",
        };
      }
    },
    grep(pattern: string, cwd: string, opts?: { glob?: string; ignoreCase?: boolean; context?: number; limit?: number }): string {
      const args = ["grep", "-rn"];
      if (opts?.ignoreCase) args.push("-i");
      if (opts?.context) args.push(`-C${opts.context}`);
      if (opts?.glob) args.push(`--include=${opts.glob}`);
      args.push(JSON.stringify(pattern), ".");
      try {
        let out = execSync(args.join(" "), { cwd, stdio: "pipe", timeout: 10000 }).toString();
        if (opts?.limit) out = out.split("\n").slice(0, opts.limit).join("\n");
        return out;
      } catch { return ""; }
    },
    find(pattern: string, cwd: string, opts?: { limit?: number }): string[] {
      try {
        const out = execSync(`find . -name "${pattern}" -type f | head -${opts?.limit ?? 50}`, { cwd, stdio: "pipe", timeout: 10000 }).toString();
        return out.trim().split("\n").filter(Boolean);
      } catch { return []; }
    },
    ls(absPath: string): string[] {
      try {
        const entries = fs.readdirSync(absPath, { withFileTypes: true });
        return entries.map((e) => e.isDirectory() ? `${e.name}/` : e.name);
      } catch { return []; }
    },
  };
}

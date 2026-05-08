import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_SRC = path.resolve(__dirname);

export interface AgentAssignment {
  agentId: number;
  focusArea: string;
  focusFiles: string[];
}

export function assignFocusAreas(concurrency: number): AgentAssignment[] {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`concurrency must be a positive integer, got: ${concurrency}`);
  }
  const allFiles = fs.readdirSync(PROJECT_SRC)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("index"))
    .map((f) => `src/${f}`);

  const areas: Record<string, string[]> = {
    "storage and data": allFiles.filter((f) => f.includes("storage") || f.includes("types") || f.includes("reward")),
    "mutation and evolution": allFiles.filter((f) => f.includes("mutation") || f.includes("crossover") || f.includes("tournament") || f.includes("sampler")),
    "agent and tools": allFiles.filter((f) => f.includes("realWorker") || f.includes("verify") || f.includes("task") || f.includes("insight")),
    "cli and health": allFiles.filter((f) => f.includes("cli") || f.includes("health") || f.includes("simulator") || f.includes("failureMode")),
  };

  const areaNames = Object.keys(areas);
  const assignments: AgentAssignment[] = [];

  for (let i = 0; i < concurrency; i++) {
    const area = areaNames[i % areaNames.length];
    assignments.push({
      agentId: i,
      focusArea: area,
      focusFiles: areas[area],
    });
  }

  return assignments;
}

export function buildFocusPrompt(assignment: AgentAssignment): string {
  return `## Your Focus Area: ${assignment.focusArea}\nPrioritize exploring these files: ${assignment.focusFiles.join(", ")}\nOther agents are working on other areas. Focus on finding and fixing ONE issue in your area.`;
}

// shared discovery board — agents write findings here
const defaultDiscoveryFile = path.resolve(PROJECT_SRC, "../.antcode/discoveries.jsonl");

function getDiscoveryFile(): string {
  return process.env.ANTCODE_DISCOVERY_FILE ?? defaultDiscoveryFile;
}

export interface Discovery {
  agentId: number;
  timestamp: string;
  file: string;
  finding: string;
  fixed: boolean;
}

function isDiscovery(value: unknown): value is Discovery {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.agentId === "number" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.file === "string" &&
    typeof candidate.finding === "string" &&
    typeof candidate.fixed === "boolean"
  );
}

export function recordDiscovery(d: Discovery): void {
  const discoveryFile = getDiscoveryFile();
  try {
    fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
    fs.appendFileSync(discoveryFile, JSON.stringify(d) + "\n", "utf8");
  } catch {
    // Best-effort shared state: append failures should not crash agent flows.
  }
}

export function getRecentDiscoveries(limit = 10): Discovery[] {
  const discoveryFile = getDiscoveryFile();
  let content = "";

  try {
    content = fs.readFileSync(discoveryFile, "utf8");
  } catch {
    return [];
  }

  const discoveries: Discovery[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isDiscovery(parsed)) discoveries.push(parsed);
    } catch {
      // Skip malformed JSONL rows and preserve valid discoveries.
    }
  }

  return discoveries.slice(-limit);
}

export function formatDiscoveriesForPrompt(): string {
  const discoveries = getRecentDiscoveries();
  if (!discoveries.length) return "";

  const fixed = discoveries.filter((d) => d.fixed);
  const unfixed = discoveries.filter((d) => !d.fixed);

  const lines = ["## Discoveries from other agents"];
  if (fixed.length) {
    lines.push("\nAlready fixed (don't repeat):");
    for (const d of fixed.slice(-5)) lines.push(`- ${d.file}: ${d.finding}`);
  }
  if (unfixed.length) {
    lines.push("\nKnown issues (you could fix one):");
    for (const d of unfixed.slice(-5)) lines.push(`- ${d.file}: ${d.finding}`);
  }
  return lines.join("\n");
}

export function withDiscoveryFileForTest<T>(run: (discoveryFile: string) => T): T {
  const previous = process.env.ANTCODE_DISCOVERY_FILE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antcode-discovery-"));
  const discoveryFile = path.join(tempDir, "discoveries.jsonl");

  process.env.ANTCODE_DISCOVERY_FILE = discoveryFile;
  try {
    return run(discoveryFile);
  } finally {
    if (previous === undefined) delete process.env.ANTCODE_DISCOVERY_FILE;
    else process.env.ANTCODE_DISCOVERY_FILE = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

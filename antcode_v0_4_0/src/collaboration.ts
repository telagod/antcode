import fs from "node:fs";
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
const discoveryFile = path.resolve(PROJECT_SRC, "../.antcode/discoveries.jsonl");

export interface Discovery {
  agentId: number;
  timestamp: string;
  file: string;
  finding: string;
  fixed: boolean;
}

export function recordDiscovery(d: Discovery): void {
  fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
  fs.appendFileSync(discoveryFile, JSON.stringify(d) + "\n", "utf8");
}

export function getRecentDiscoveries(limit = 10): Discovery[] {
  try {
    const lines = fs.readFileSync(discoveryFile, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as Discovery);
  } catch { return []; }
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

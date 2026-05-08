import { completeSimple } from "@mariozechner/pi-ai";
import { ExperienceKey } from "./types";
import { RealTask } from "./tasks";
import { createPiModel, API_KEY } from "./runtime/piModel";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_SRC = path.resolve(__dirname);

const TASKGEN_TIMEOUT_MS = Number(process.env.ANTCODE_TASKGEN_TIMEOUT_MS ?? 30000);


async function withTimeout<T>(label: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function scanSourceFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const entries = fs.readdirSync(PROJECT_SRC).filter((f) => f.endsWith(".ts"));
  for (const f of entries) {
    const content = fs.readFileSync(path.join(PROJECT_SRC, f), "utf8");
    files[`src/${f}`] = content;
  }
  return files;
}

function buildScanPrompt(files: Record<string, string>): { instructions: string; input: string } {
  const hasTestFramework = fs.existsSync(path.resolve(PROJECT_SRC, "../node_modules/vitest")) ||
    fs.existsSync(path.resolve(PROJECT_SRC, "../node_modules/jest"));

  const fileSummaries = Object.entries(files).map(([name, content]) => {
    const lines = content.split("\n");
    const exports = lines.filter((l) => l.trim().startsWith("export ")).slice(0, 10);
    return `### ${name} (${lines.length} lines)\n${exports.join("\n")}`;
  }).join("\n\n");

  const focusAreas = hasTestFramework
    ? "missing error handling, missing tests, code that could be cleaner, type safety gaps, dead code"
    : "missing error handling, code that could be cleaner, type safety gaps, dead code, missing documentation, duplicate logic";

  return {
    instructions: `You are a code quality analyst. You scan TypeScript source files and identify concrete improvement tasks.

Respond with ONLY a JSON array (no markdown, no explanation). Each item:
{
  "goal_pattern": "add_cli_command | fix_type_error | refactor_module | add_test | fix_bug | improve_error_handling | remove_dead_code | add_documentation",
  "module_region": "string — which module area",
  "description": "string — specific task description, actionable",
  "target_files": ["src/file.ts"],
  "risk_level": "low | low_to_medium | medium | high",
  "priority": 1-5
}

Rules:
- Only suggest tasks that are concretely actionable on the given code
- Max 5 tasks, sorted by priority
- Focus on: ${focusAreas}
- Do NOT suggest tasks that are already done
${hasTestFramework ? "" : "- IMPORTANT: Do NOT suggest 'add_test' tasks — no test framework is installed in this project"}`,
    input: `## Source Files\n\n${fileSummaries}`,
  };
}
// TASKGEN_PART2

interface RawTask {
  goal_pattern: string;
  module_region: string;
  description: string;
  target_files: string[];
  risk_level: string;
  priority: number;
}

function failGenerateTasks(message: string, cause?: unknown): never {
  const details = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  throw new Error(details ? `${message}: ${details}` : message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRawTask(raw: RawTask, index: number): RawTask {
  if (!isNonEmptyString(raw.goal_pattern)) {
    failGenerateTasks(`Upstream task ${index} is missing a valid goal_pattern`);
  }
  if (!isNonEmptyString(raw.module_region)) {
    failGenerateTasks(`Upstream task ${index} is missing a valid module_region`);
  }
  if (!isNonEmptyString(raw.description)) {
    failGenerateTasks(`Upstream task ${index} is missing a valid description`);
  }
  if (!Array.isArray(raw.target_files) || raw.target_files.length === 0 || raw.target_files.some((f) => !isNonEmptyString(f))) {
    failGenerateTasks(`Upstream task ${index} is missing valid target_files`);
  }

  return {
    ...raw,
    goal_pattern: raw.goal_pattern.trim(),
    module_region: raw.module_region.trim(),
    description: raw.description.trim(),
    target_files: raw.target_files.map((f) => f.trim()),
  };
}

function validateRealTask(task: RealTask, index: number): RealTask {
  if (!isNonEmptyString(task.key.goal_pattern)) {
    failGenerateTasks(`Generated task ${index} is missing key.goal_pattern`);
  }
  if (!isNonEmptyString(task.key.module_region)) {
    failGenerateTasks(`Generated task ${index} is missing key.module_region`);
  }
  if (!Array.isArray(task.key.context_shape) || task.key.context_shape.some((entry) => !isNonEmptyString(entry))) {
    failGenerateTasks(`Generated task ${index} has invalid key.context_shape`);
  }
  if (!isNonEmptyString(task.description)) {
    failGenerateTasks(`Generated task ${index} is missing description`);
  }
  if (!Array.isArray(task.target_files) || task.target_files.length === 0 || task.target_files.some((f) => !isNonEmptyString(f))) {
    failGenerateTasks(`Generated task ${index} has invalid target_files`);
  }
  if (!task.acceptance || typeof task.acceptance.typecheck !== "boolean") {
    failGenerateTasks(`Generated task ${index} has invalid acceptance criteria`);
  }

  return task;
}

function parseRawTasks(raw: string): RawTask[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    failGenerateTasks("Upstream task generation did not return a JSON array");
  }
  return parsed as RawTask[];
}

function toRealTask(raw: RawTask, fileSizes: Record<string, number>): RealTask {
  const risk = (["low", "low_to_medium", "medium", "high"].includes(raw.risk_level) ? raw.risk_level : "low_to_medium") as ExperienceKey["risk_level"];
  const isLarge = raw.target_files.some((f) => (fileSizes[f] ?? 0) > 500);
  return {
    key: {
      goal_pattern: raw.goal_pattern,
      module_region: raw.module_region,
      error_pattern: undefined,
      context_shape: raw.target_files.map((f) => f.replace("src/", "").replace(".ts", "")),
      risk_level: risk,
    },
    description: raw.description,
    target_files: raw.target_files,
    acceptance: {
      typecheck: true,
      test_command: raw.goal_pattern === "add_test" ? undefined : "npx tsx src/cli.ts run-experiment 2",
    },
    priority: typeof raw.priority === "number" ? raw.priority : 3,
    is_large: isLarge,
  };
}

async function generateTaskTextWithPi(prompt: { instructions: string; input: string }): Promise<string> {
  const message = await withTimeout("pi task generation", TASKGEN_TIMEOUT_MS, (signal) => completeSimple(
    createPiModel(),
    {
      systemPrompt: prompt.instructions,
      messages: [{ role: "user", content: prompt.input, timestamp: Date.now() }],
    },
    {
      signal,
      apiKey: API_KEY,
      maxRetries: 2,
      timeoutMs: TASKGEN_TIMEOUT_MS,
    },
  ));

  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function rawTasksToRealTasks(rawTasks: RawTask[], fileSizes: Record<string, number>): RealTask[] {
  // filter out add_test tasks if no test framework is installed
  const hasTestFramework = fs.existsSync(path.resolve(PROJECT_SRC, "../node_modules/vitest")) ||
    fs.existsSync(path.resolve(PROJECT_SRC, "../node_modules/jest"));
  const filtered = rawTasks.filter((t) => {
    if (t.goal_pattern === "add_test" && !hasTestFramework) return false;
    return true;
  });
  const tasks = filtered
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 5)
    .map((task, index) => toRealTask(validateRawTask(task, index), fileSizes))
    .map((task, index) => validateRealTask(task, index));
  console.log(`  taskGen: discovered ${tasks.length} tasks${rawTasks.length !== filtered.length ? ` (filtered ${rawTasks.length - filtered.length} test tasks — no test framework)` : ""}`);
  for (const t of tasks) console.log(`    - [${t.key.goal_pattern}]${t.is_large ? " [LARGE]" : ""} p=${t.priority} ${t.description.slice(0, 70)}`);
  return tasks;
}

export async function generateTasks(): Promise<RealTask[]> {
  if (!API_KEY) {
    console.log("  taskGen: ANTCODE_LLM_API_KEY not set; fallback to static tasks");
    return [];
  }

  try {
    const files = scanSourceFiles();
    const fileSizes: Record<string, number> = {};
    for (const [name, content] of Object.entries(files)) {
      fileSizes[name] = content.split("\n").length;
    }
    const prompt = buildScanPrompt(files);
    const fullText = await generateTaskTextWithPi(prompt);

    if (!fullText) return [];

    return rawTasksToRealTasks(parseRawTasks(fullText), fileSizes);
  } catch (e) {
    const details = e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
    console.error(`  taskGen: failed to generate tasks${details ? `: ${details}` : ""}`);
    return [];
  }
}

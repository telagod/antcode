import { Attempt, ExperienceKey, StrategyGenome } from "./types";
import { RealTask } from "./tasks";
import { createSlot, resetSlot, cleanupSlot, readSlotFile, captureBaseline, verifyPatch, mergeToProject } from "./verify";
import { gatherInsights, formatInsightsForPrompt } from "./insights";

const BASE_URL = process.env.ANTCODE_LLM_BASE_URL ?? "https://sub.foxnio.com/v1";
const API_KEY = process.env.ANTCODE_LLM_API_KEY ?? "sk-1b3367b48959b1d2cfb75e6756fc69c34ca9f7328d8ff21721929853002de19f";
const MODEL = process.env.ANTCODE_LLM_MODEL ?? "gpt-5.4";

let attemptCounter = 0;

// === Context Minimum Units (CMU) ===
// Each unit is an independently cacheable prompt fragment.
// Order is fixed: U0 → U1 → U2[] → U3 → U4 → U5
// Parallel requests sharing the same task differ only at U5 → max prefix cache hit.

// U0: System Instructions — never changes
const U0_SYSTEM = `You are a code agent working on a TypeScript project. You receive source code, a task, and strategy constraints. You must produce working code changes.

## Output Format
Respond with ONLY a valid JSON object (no markdown fences, no explanation). Shape:
{
  "files": {
    "src/filename.ts": "...full file content after your changes..."
  },
  "tests_added": 0,
  "notes": ["what you did and why"]
}

Rules:
- "files" must contain the COMPLETE content of each modified or created file
- Only include files you actually changed
- Do not truncate file content — include every line
- Respect the strategy constraints (patch size, boundary, granularity)`;

// U1: Type definitions — changes only when types.ts is modified
function u1Types(slot: string): string {
  const content = readSlotFile(slot, "src/types.ts");
  if (!content) return "";
  return `## Type Definitions\n\`\`\`typescript\n${extractSignatures(content)}\n\`\`\``;
}

// U2: Target file content — one unit per file, invalidates independently
function u2File(slot: string, filePath: string, granularity: string): string {
  const content = readSlotFile(slot, filePath);
  if (!content) return `## ${filePath}\n(new file — does not exist yet)`;

  if (granularity === "tiny" || granularity === "small") {
    const sigs = extractSignatures(content);
    const preview = content.split("\n").slice(0, 60).join("\n");
    return `## ${filePath} (compact)\n### Signatures\n\`\`\`typescript\n${sigs}\n\`\`\`\n### Preview (60 lines)\n\`\`\`typescript\n${preview}\n\`\`\``;
  }
  return `## ${filePath}\n\`\`\`typescript\n${content}\`\`\``;
}

// U3: Task description — stable per ExperienceKey
function u3Task(task: RealTask): string {
  return `## Task\n${task.description}`;
}

// U4: Shared insights — updates each round but structure is stable
function u4Insights(insights: string): string {
  return insights || "";
}

// U5: Strategy constraints — varies per genome, always last
function u5Strategy(genome: StrategyGenome): string {
  return `## Strategy Constraints (${genome.id})
- patch_granularity: ${genome.action_strategy.patch_granularity}
- max_diff_lines: ${genome.boundary_strategy.max_diff_lines}
- prefer_existing_pattern: ${genome.action_strategy.prefer_existing_pattern}
- forbid_architecture_change: ${genome.action_strategy.forbid_architecture_change}
- allowed_file_policy: ${genome.boundary_strategy.allowed_file_policy}
- validation_required: ${genome.validation_strategy.required.join(", ")}`;
}

function extractSignatures(content: string): string {
  const lines = content.split("\n");
  const sigs: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("export ") || trimmed.startsWith("interface ") || trimmed.startsWith("type ") ||
        trimmed.match(/^(async\s+)?function\s/) || trimmed.match(/^(export\s+)?(const|let)\s+\w+\s*[=:]/) ||
        trimmed.startsWith("class ")) {
      sigs.push(line);
    }
  }
  return sigs.join("\n");
}

// Compose all units in fixed order
function buildPrompt(task: RealTask, genome: StrategyGenome, slot: string, insights = ""): { instructions: string; input: string } {
  const granularity = genome.action_strategy.patch_granularity;
  const units: string[] = [
    u1Types(slot),
    ...task.target_files.map((f) => u2File(slot, f, granularity)),
    u3Task(task),
    u4Insights(insights),
    u5Strategy(genome),
  ].filter(Boolean);

  return {
    instructions: U0_SYSTEM,
    input: units.join("\n\n"),
  };
}
// PLACEHOLDER_REAL_ATTEMPT

interface ResponsesAPIResponse {
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  error?: { message: string };
}

function extractText(resp: ResponsesAPIResponse): string {
  if (resp.output) {
    for (const item of resp.output) {
      if (item.type === "message" && item.content) {
        for (const c of item.content) {
          if (c.type === "output_text" && c.text) return c.text;
        }
      }
    }
  }
  throw new Error(`Unexpected response structure: ${JSON.stringify(resp).slice(0, 300)}`);
}

async function streamRequest(prompt: { instructions: string; input: string }): Promise<{ text: string; usage?: { input_tokens?: number; output_tokens?: number; cached_tokens?: number } }> {
  const body = {
    model: MODEL,
    instructions: prompt.instructions,
    input: prompt.input,
    stream: true,
  };

  const res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body reader");

  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";
  let usage: { input_tokens?: number; output_tokens?: number; cached_tokens?: number } | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        if (event.type === "response.output_text.delta" && event.delta) {
          fullText += event.delta;
        } else if (event.type === "response.completed" && event.response) {
          // only extract usage here — text already collected via deltas
          if (event.response.usage) {
            usage = {
              input_tokens: event.response.usage.input_tokens,
              output_tokens: event.response.usage.output_tokens,
              cached_tokens: event.response.usage.input_tokens_details?.cached_tokens ?? 0,
            };
          }
        }
      } catch { /* skip unparseable lines */ }
    }
  }

  if (!fullText) throw new Error("Stream completed with no text output");
  return { text: fullText, usage };
}

async function callWithRetry(prompt: { instructions: string; input: string }, retries = 2): Promise<{ text: string; usage?: { input_tokens?: number; output_tokens?: number; cached_tokens?: number } }> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await streamRequest(prompt);
    } catch (e) {
      const msg = (e as Error).message;
      if (i < retries && (msg.includes("504") || msg.includes("502") || msg.includes("timeout"))) {
        console.error(`  retry ${i + 1}/${retries}: ${msg.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

interface LLMOutput {
  files: Record<string, string>;
  tests_added?: number;
  notes?: string[];
}

function parseLLMOutput(raw: string): LLMOutput {
  let text = raw.trim();
  // try direct JSON parse first (most common case)
  if (text.startsWith("{")) {
    try { return JSON.parse(text) as LLMOutput; } catch { /* fall through */ }
  }
  // try extracting from markdown fence
  const fenceStart = text.indexOf("```");
  if (fenceStart !== -1) {
    const afterFence = text.indexOf("\n", fenceStart);
    const fenceEnd = text.lastIndexOf("```");
    if (afterFence !== -1 && fenceEnd > afterFence) {
      text = text.slice(afterFence + 1, fenceEnd).trim();
      try { return JSON.parse(text) as LLMOutput; } catch { /* fall through */ }
    }
  }
  // last resort: find first { and last }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
    return JSON.parse(text) as LLMOutput;
  }
  throw new Error("Could not extract JSON from LLM output");
}

export async function realAttempt(
  key: ExperienceKey,
  genome: StrategyGenome,
  task?: RealTask,
  slotId = 0,
  autoMerge = false,
): Promise<RealAttemptResult> {
  attemptCounter += 1;
  const id = `attempt_${String(attemptCounter).padStart(4, "0")}`;

  if (!task) {
    return fallbackResult(id, key, genome, "no matching real task for this ExperienceKey");
  }

  const slot = createSlot(slotId);
  resetSlot(slot);
  captureBaseline(slot);

  const insights = formatInsightsForPrompt(gatherInsights(process.cwd(), key.goal_pattern));

  let llmOutput: LLMOutput;
  let tokenUsage: { input_tokens?: number; output_tokens?: number; cached_tokens?: number } | undefined;
  try {
    const { text, usage } = await callWithRetry(buildPrompt(task, genome, slot, insights));
    tokenUsage = usage;
    if (usage) {
      const cacheRate = usage.input_tokens ? ((usage.cached_tokens ?? 0) / usage.input_tokens * 100).toFixed(1) : "0";
      console.log(`    tokens: in=${usage.input_tokens} out=${usage.output_tokens} cached=${usage.cached_tokens ?? 0} (${cacheRate}%)`);
    }
    try {
      llmOutput = parseLLMOutput(text);
    } catch (parseErr) {
      cleanupSlot(slot);
      console.error(`  parse error, raw response (first 300 chars): ${text.slice(0, 300)}`);
      return fallbackResult(id, key, genome, `parse error: ${(parseErr as Error).message.slice(0, 100)}`);
    }
  } catch (e) {
    cleanupSlot(slot);
    console.error(`  LLM error: ${(e as Error).message.slice(0, 120)}`);
    return fallbackResult(id, key, genome, (e as Error).message.slice(0, 200));
  }

  if (!llmOutput.files || Object.keys(llmOutput.files).length === 0) {
    cleanupSlot(slot);
    console.error(`  no files in LLM output, keys: ${JSON.stringify(Object.keys(llmOutput))}`);
    return fallbackResult(id, key, genome, "LLM returned no files");
  }

  const verify = verifyPatch(slot, llmOutput.files, task.acceptance.test_command);

  const boundaryViolations: string[] = [];
  for (const f of verify.files_changed) {
    if (!task.target_files.includes(f)) {
      boundaryViolations.push(`file outside target: ${f}`);
    }
  }
  if (verify.diff_lines > genome.boundary_strategy.max_diff_lines) {
    boundaryViolations.push(`diff ${verify.diff_lines} exceeds max ${genome.boundary_strategy.max_diff_lines}`);
  }

  let result: Attempt["result"] = "failure";
  if (verify.patch_applied && verify.typecheck_passed && (verify.test_passed === true || verify.test_passed === null)) {
    result = boundaryViolations.length > 0 ? "blocked" : "success";
  } else if (!verify.patch_applied) {
    result = "blocked";
  }

  let mergeFiles: Record<string, string> | undefined;

  if (result === "success" && autoMerge) {
    // use LLM output directly — no need to re-read from slot
    mergeFiles = llmOutput.files;
    verify.notes.push("ready to merge");
  }

  cleanupSlot(slot);

  const attempt: Attempt = {
    id,
    timestamp: new Date().toISOString(),
    experience_key: key,
    strategy_genome_id: genome.id,
    worker: "other",
    result,
    files_changed: verify.files_changed,
    diff_lines: verify.diff_lines,
    tests_added: llmOutput.tests_added ?? 0,
    commands_run: ["tsc --noEmit", ...(task.acceptance.test_command ? [task.acceptance.test_command] : [])],
    boundary_violations: boundaryViolations,
    notes: [
      ...(llmOutput.notes ?? []),
      ...verify.notes,
      ...(tokenUsage ? [`tokens:in=${tokenUsage.input_tokens},out=${tokenUsage.output_tokens},cached=${tokenUsage.cached_tokens ?? 0}`] : []),
    ],
  };

  return { attempt, mergeFiles };
}

export interface RealAttemptResult {
  attempt: Attempt;
  mergeFiles?: Record<string, string>;
}

function fallbackResult(id: string, key: ExperienceKey, genome: StrategyGenome, reason: string): RealAttemptResult {
  return {
    attempt: {
      id,
      timestamp: new Date().toISOString(),
      experience_key: key,
      strategy_genome_id: genome.id,
      worker: "other",
      result: "failure",
      files_changed: [],
      diff_lines: 0,
      tests_added: 0,
      commands_run: [],
      boundary_violations: [],
      notes: [`fallback: ${reason}`],
    },
  };
}

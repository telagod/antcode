import { Attempt, ExperienceKey, StrategyGenome } from "./types";
import { RealTask } from "./tasks";
import { createSlot, resetSlot, cleanupSlot, readSlotFile, captureBaseline, verifyPatch } from "./verify";
import { gatherInsights, formatInsightsForPrompt } from "./insights";

const BASE_URL = process.env.ANTCODE_LLM_BASE_URL ?? "https://sub.foxnio.com/v1";
const API_KEY = process.env.ANTCODE_LLM_API_KEY ?? "sk-1b3367b48959b1d2cfb75e6756fc69c34ca9f7328d8ff21721929853002de19f";
const MODEL = process.env.ANTCODE_LLM_MODEL ?? "gpt-5.4";

let attemptCounter = 0;

// === Tool Definitions (stable prefix — maximizes cache hit) ===
const TOOLS = [
  {
    type: "function",
    name: "write_file",
    description: "Write or overwrite a file with the given content. Use for new files or when most of the file changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path, e.g. src/storage.ts" },
        content: { type: "string", description: "Complete file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    type: "function",
    name: "edit_file",
    description: "Apply a targeted edit to an existing file. Use when only a small part of the file changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
        old_text: { type: "string", description: "Exact text to find and replace" },
        new_text: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    type: "function",
    name: "done",
    description: "Signal that all changes are complete. Call this after all file edits.",
    parameters: {
      type: "object",
      properties: {
        notes: { type: "array", items: { type: "string" }, description: "What you did and why" },
        tests_added: { type: "number", description: "Number of test cases added" },
      },
      required: ["notes"],
    },
  },
];
// REALWORKER_PART2

// === System Instructions (stable prefix) ===
const SYSTEM_INSTRUCTIONS = `You are a code agent working on a TypeScript project. Use the provided tools to make changes:
- Use edit_file for targeted changes (preferred — saves tokens)
- Use write_file only for new files or complete rewrites
- Call done when finished with a summary of what you did
- Make the minimum changes needed to complete the task
- Do not change files that don't need changing`;

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

function buildInput(task: RealTask, genome: StrategyGenome, slot: string, insights: string): string {
  const units: string[] = [];

  // type signatures
  const types = readSlotFile(slot, "src/types.ts");
  if (types && !task.target_files.includes("src/types.ts")) {
    units.push(`## Type Definitions\n\`\`\`typescript\n${extractSignatures(types)}\n\`\`\``);
  }

  // target files
  for (const f of task.target_files) {
    const content = readSlotFile(slot, f);
    if (!content) { units.push(`## ${f}\n(new file)`); continue; }
    units.push(`## ${f}\n\`\`\`typescript\n${content}\`\`\``);
  }

  // task
  units.push(`## Task\n${task.description}`);

  // insights
  if (insights) units.push(insights);

  // strategy
  units.push(`## Strategy (${genome.id})
- prefer_existing_pattern: ${genome.action_strategy.prefer_existing_pattern}
- forbid_architecture_change: ${genome.action_strategy.forbid_architecture_change}
- validation: ${genome.validation_strategy.required.join(", ")}`);

  return units.join("\n\n");
}

// === Streaming with tool use loop ===
interface Usage { input_tokens: number; output_tokens: number; cached_tokens: number }

interface ToolCall {
  name: string;
  arguments: string;
  call_id: string;
}

interface StreamResult {
  responseId: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  textOutput?: string;
}

async function streamOnce(body: Record<string, unknown>, retries = 2): Promise<StreamResult> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${BASE_URL}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (attempt < retries && (res.status === 502 || res.status === 504 || res.status === 429)) {
        console.error(`    retry ${attempt + 1}/${retries}: ${res.status}`);
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw new Error(`API error (${res.status}): ${errText.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body reader");

  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | undefined;
  let responseId = "";
  let textOutput = "";
  const toolCalls: ToolCall[] = [];
  const argBuffers = new Map<number, { name: string; args: string; call_id: string }>();

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
        const ev = JSON.parse(data);
        if (ev.type === "response.created" && ev.response?.id) {
          responseId = ev.response.id;
        } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          argBuffers.set(ev.output_index, { name: ev.item.name, args: "", call_id: ev.item.call_id ?? "" });
        } else if (ev.type === "response.function_call_arguments.delta") {
          const buf = argBuffers.get(ev.output_index);
          if (buf) buf.args += ev.delta;
        } else if (ev.type === "response.function_call_arguments.done") {
          const buf = argBuffers.get(ev.output_index);
          if (buf) toolCalls.push({ name: buf.name, arguments: buf.args, call_id: buf.call_id });
        } else if (ev.type === "response.output_text.delta" && ev.delta) {
          textOutput += ev.delta;
        } else if (ev.type === "response.completed" && ev.response?.usage) {
          usage = {
            input_tokens: ev.response.usage.input_tokens,
            output_tokens: ev.response.usage.output_tokens,
            cached_tokens: ev.response.usage.input_tokens_details?.cached_tokens ?? 0,
          };
          if (ev.response.id) responseId = ev.response.id;
        }
      } catch { /* skip */ }
    }
  }

  return { responseId, toolCalls, usage, textOutput };
  }
  throw new Error("streamOnce: all retries exhausted");
}

function executeToolCall(tc: ToolCall, slot: string, fileState: Record<string, string>): string {
  try {
    const args = JSON.parse(tc.arguments);
    if (tc.name === "write_file" && args.path && args.content) {
      fileState[args.path] = args.content;
      return `wrote ${args.path} (${args.content.split("\n").length} lines)`;
    } else if (tc.name === "edit_file" && args.path) {
      const existing = fileState[args.path] ?? readSlotFile(slot, args.path) ?? "";
      if (existing.includes(args.old_text)) {
        fileState[args.path] = existing.replace(args.old_text, args.new_text);
        return `edited ${args.path}`;
      }
      return `edit_file: old_text not found in ${args.path}`;
    } else if (tc.name === "done") {
      return "done";
    }
    return `unknown tool: ${tc.name}`;
  } catch (e) {
    return `error: ${(e as Error).message.slice(0, 80)}`;
  }
}

const MAX_TOOL_ROUNDS = 8;

async function runToolLoop(
  instructions: string,
  input: string,
  slot: string,
): Promise<{ files: Record<string, string>; notes: string[]; testsAdded: number; totalUsage: Usage }> {
  const fileState: Record<string, string> = {};
  const notes: string[] = [];
  let testsAdded = 0;
  const totalUsage: Usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };

  // Responses API input: flat array of items (no role wrappers)
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: input },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body: Record<string, unknown> = {
      model: MODEL, instructions, input: messages, tools: TOOLS, tool_choice: "auto", stream: true,
    };

    let result: StreamResult;
    try {
      result = await streamOnce(body);
    } catch (e) {
      // if we already have file changes from previous rounds, return them instead of throwing
      if (Object.keys(fileState).length > 0) {
        notes.push(`tool loop interrupted at round ${round}: ${(e as Error).message.slice(0, 80)}`);
        break;
      }
      throw e;
    }
    if (result.usage) {
      totalUsage.input_tokens += result.usage.input_tokens;
      totalUsage.output_tokens += result.usage.output_tokens;
      totalUsage.cached_tokens += result.usage.cached_tokens;
    }

    if (result.toolCalls.length === 0) {
      if (result.textOutput) notes.push(result.textOutput.slice(0, 200));
      console.log(`      round ${round}: no tool calls, text=${result.textOutput?.slice(0, 80) ?? "none"}`);
      break;
    }

    console.log(`      round ${round}: ${result.toolCalls.map(tc => tc.name).join(", ")}`);

    // add function_call items directly to input array
    for (const tc of result.toolCalls) {
      messages.push({ type: "function_call", id: tc.call_id, call_id: tc.call_id, name: tc.name, arguments: tc.arguments });
    }

    // execute and add function_call_output items
    let isDone = false;
    for (const tc of result.toolCalls) {
      if (tc.name === "done") {
        try {
          const args = JSON.parse(tc.arguments);
          if (args.notes) notes.push(...args.notes);
          if (args.tests_added) testsAdded = args.tests_added;
        } catch { /* skip */ }
        messages.push({ type: "function_call_output", call_id: tc.call_id, output: "done" });
        isDone = true;
      } else {
        const output = executeToolCall(tc, slot, fileState);
        messages.push({ type: "function_call_output", call_id: tc.call_id, output });
      }
    }

    if (isDone) break;
  }

  return { files: fileState, notes, testsAdded, totalUsage };
}
// REALWORKER_PART3

export interface RealAttemptResult {
  attempt: Attempt;
  mergeFiles?: Record<string, string>;
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
    return fallbackResult(id, key, genome, "no matching real task");
  }

  const slot = createSlot(slotId);
  resetSlot(slot);
  captureBaseline(slot);

  const insights = formatInsightsForPrompt(gatherInsights(process.cwd(), key.goal_pattern));
  const input = buildInput(task, genome, slot, insights);

  let files: Record<string, string>;
  let notes: string[];
  let testsAdded: number;
  let totalUsage: Usage;
  try {
    const result = await runToolLoop(SYSTEM_INSTRUCTIONS, input, slot);
    files = result.files;
    notes = result.notes;
    testsAdded = result.testsAdded;
    totalUsage = result.totalUsage;
    const cacheRate = totalUsage.input_tokens ? (totalUsage.cached_tokens / totalUsage.input_tokens * 100).toFixed(1) : "0";
    console.log(`    tokens: in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} cached=${totalUsage.cached_tokens} (${cacheRate}%) rounds=${notes.length > 0 ? "ok" : "?"}`);
  } catch (e) {
    cleanupSlot(slot);
    console.error(`  LLM error: ${(e as Error).message.slice(0, 120)}`);
    return fallbackResult(id, key, genome, (e as Error).message.slice(0, 200));
  }

  if (Object.keys(files).length === 0) {
    cleanupSlot(slot);
    return fallbackResult(id, key, genome, "no file changes from tool calls");
  }

  const verify = verifyPatch(slot, files, task.acceptance.test_command);

  const boundaryViolations: string[] = [];
  for (const f of verify.files_changed) {
    if (!task.target_files.includes(f)) {
      boundaryViolations.push(`file outside target: ${f}`);
    }
  }

  let result: Attempt["result"] = "failure";
  if (verify.patch_applied && verify.typecheck_passed && (verify.test_passed === true || verify.test_passed === null)) {
    result = boundaryViolations.length > 0 ? "blocked" : "success";
  } else if (!verify.patch_applied) {
    result = "blocked";
  }

  let mergeFiles: Record<string, string> | undefined;
  if (result === "success" && autoMerge) {
    mergeFiles = files;
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
    tests_added: testsAdded,
    commands_run: ["tsc --noEmit", ...(task.acceptance.test_command ? [task.acceptance.test_command] : [])],
    boundary_violations: boundaryViolations,
    notes: [
      ...notes,
      ...verify.notes,
      ...(totalUsage ? [`tokens:in=${totalUsage.input_tokens},out=${totalUsage.output_tokens},cached=${totalUsage.cached_tokens}`] : []),
    ],
  };

  return { attempt, mergeFiles };
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

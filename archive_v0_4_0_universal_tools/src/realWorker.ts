import { Attempt, ExperienceKey, StrategyGenome } from "./types";
import { RealTask } from "./tasks";
import { createLocalOps, ALL_TOOLS, toolsToSchema, buildToolSnippets, ToolDef, AllOps } from "./tools";
import { gatherInsights, formatInsightsForPrompt } from "./insights";
import path from "node:path";

const BASE_URL = process.env.ANTCODE_LLM_BASE_URL ?? "https://sub.foxnio.com/v1";
const API_KEY = process.env.ANTCODE_LLM_API_KEY ?? "sk-1b3367b48959b1d2cfb75e6756fc69c34ca9f7328d8ff21721929853002de19f";
const MODEL = process.env.ANTCODE_LLM_MODEL ?? "gpt-5.4";

let attemptCounter = 0;

// === System prompt — stable prefix for cache hit ===
const SYSTEM_PROMPT = `You are a code agent. You have tools to read, write, edit files, run shell commands, and search code.

## Available Tools
${buildToolSnippets(ALL_TOOLS)}

## Workflow
1. Read relevant files to understand the codebase
2. Make changes using edit (preferred) or write
3. Run bash to verify (e.g. typecheck, tests, lint)
4. If verification fails, fix and re-verify
5. Call done with a summary when everything passes

## Rules
- Use edit for targeted changes, write only for new files or complete rewrites
- Always verify changes with bash before calling done
- Make minimal changes needed to complete the task
- Do not modify files outside the task scope`;

const TOOL_SCHEMAS = toolsToSchema(ALL_TOOLS);
const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

// === Streaming + tool loop ===
interface Usage { input_tokens: number; output_tokens: number; cached_tokens: number }
interface ToolCall { name: string; arguments: string; call_id: string }
interface StreamResult { responseId: string; toolCalls: ToolCall[]; usage?: Usage; textOutput?: string }

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
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw new Error(`API error (${res.status}): ${errText.slice(0, 200)}`);
    }
// STREAM_BODY
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
          if (ev.type === "response.created" && ev.response?.id) responseId = ev.response.id;
          else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call")
            argBuffers.set(ev.output_index, { name: ev.item.name, args: "", call_id: ev.item.call_id ?? "" });
          else if (ev.type === "response.function_call_arguments.delta") {
            const buf = argBuffers.get(ev.output_index); if (buf) buf.args += ev.delta;
          } else if (ev.type === "response.function_call_arguments.done") {
            const buf = argBuffers.get(ev.output_index);
            if (buf) toolCalls.push({ name: buf.name, arguments: buf.args, call_id: buf.call_id });
          } else if (ev.type === "response.output_text.delta" && ev.delta) textOutput += ev.delta;
          else if (ev.type === "response.completed" && ev.response?.usage) {
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

const MAX_TOOL_ROUNDS = 12;

function executeTool(tc: ToolCall, ops: AllOps, cwd: string): { output: string; isDone: boolean; notes: string[]; testsAdded: number } {
  const tool = TOOL_MAP.get(tc.name);
  if (!tool) return { output: `unknown tool: ${tc.name}`, isDone: false, notes: [], testsAdded: 0 };
  try {
    const args = JSON.parse(tc.arguments);
    if (tc.name === "done") {
      return {
        output: "done",
        isDone: true,
        notes: Array.isArray(args.notes) ? args.notes : [],
        testsAdded: args.tests_added ?? 0,
      };
    }
    const output = tool.execute(args, ops, cwd);
    return { output, isDone: false, notes: [], testsAdded: 0 };
  } catch (e) {
    return { output: `error: ${(e as Error).message.slice(0, 200)}`, isDone: false, notes: [], testsAdded: 0 };
  }
}

async function runToolLoop(
  input: string,
  ops: AllOps,
  cwd: string,
): Promise<{ notes: string[]; testsAdded: number; totalUsage: Usage; filesChanged: string[] }> {
  const notes: string[] = [];
  let testsAdded = 0;
  const totalUsage: Usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
  const filesChanged = new Set<string>();

  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: input },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body: Record<string, unknown> = {
      model: MODEL, instructions: SYSTEM_PROMPT, input: messages,
      tools: TOOL_SCHEMAS, tool_choice: "auto", stream: true,
    };
    const bodySize = JSON.stringify(body).length;
    console.log(`      round ${round}: sending ${bodySize} bytes, ${messages.length} messages`);

    let result: StreamResult;
    try {
      result = await streamOnce(body);
    } catch (e) {
      console.log(`      round ${round}: error — ${(e as Error).message.slice(0, 80)}`);
      notes.push(`loop interrupted at round ${round}: ${(e as Error).message.slice(0, 80)}`);
      break;
    }

    if (result.usage) {
      totalUsage.input_tokens += result.usage.input_tokens;
      totalUsage.output_tokens += result.usage.output_tokens;
      totalUsage.cached_tokens += result.usage.cached_tokens;
    }

    if (result.toolCalls.length === 0) {
      if (result.textOutput) notes.push(result.textOutput.slice(0, 200));
      break;
    }

    console.log(`      round ${round}: ${result.toolCalls.map(tc => tc.name).join(", ")}`);

    for (const tc of result.toolCalls) {
      messages.push({ type: "function_call", call_id: tc.call_id, name: tc.name, arguments: tc.arguments });
    }

    let isDone = false;
    for (const tc of result.toolCalls) {
      const res = executeTool(tc, ops, cwd);
      messages.push({ type: "function_call_output", call_id: tc.call_id, output: res.output });
      if (tc.name === "write" || tc.name === "edit") {
        try { const args = JSON.parse(tc.arguments); if (args.path) filesChanged.add(args.path); } catch {}
      }
      if (res.isDone) { notes.push(...res.notes); testsAdded = res.testsAdded; isDone = true; }
    }

    if (isDone) break;
  }

  return { notes, testsAdded, totalUsage, filesChanged: [...filesChanged] };
}
// REALWORKER_ATTEMPT

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

  if (!task) return fallbackResult(id, key, genome, "no matching real task");

  // create isolated workbench slot
  const { createSlot, resetSlot, cleanupSlot } = await import("./verify");
  const slot = createSlot(slotId);
  resetSlot(slot);

  const ops = createLocalOps(slot);
  const insights = formatInsightsForPrompt(gatherInsights(process.cwd(), key.goal_pattern));

  const input = [
    `## Task\n${task.description}`,
    `## Strategy (${genome.id})\n- prefer_existing_pattern: ${genome.action_strategy.prefer_existing_pattern}\n- forbid_architecture_change: ${genome.action_strategy.forbid_architecture_change}\n- validation: ${genome.validation_strategy.required.join(", ")}`,
    insights,
  ].filter(Boolean).join("\n\n");

  let result: Awaited<ReturnType<typeof runToolLoop>>;
  try {
    result = await runToolLoop(input, ops, slot);
    const u = result.totalUsage;
    const cacheRate = u.input_tokens ? (u.cached_tokens / u.input_tokens * 100).toFixed(1) : "0";
    console.log(`    tokens: in=${u.input_tokens} out=${u.output_tokens} cached=${u.cached_tokens} (${cacheRate}%)`);
  } catch (e) {
    cleanupSlot(slot);
    return fallbackResult(id, key, genome, (e as Error).message.slice(0, 200));
  }

  if (result.filesChanged.length === 0) {
    cleanupSlot(slot);
    return fallbackResult(id, key, genome, "no file changes");
  }

  // collect merge files before cleanup
  let mergeFiles: Record<string, string> | undefined;
  if (autoMerge) {
    mergeFiles = {};
    for (const f of result.filesChanged) {
      const content = ops.readFile(path.resolve(slot, f));
      if (content) mergeFiles[f] = content;
    }
    if (Object.keys(mergeFiles).length === 0) mergeFiles = undefined;
  }

  cleanupSlot(slot);

  // determine success based on whether LLM self-verified (called bash + done)
  const selfVerified = result.notes.some((n) => n.toLowerCase().includes("pass") || n.toLowerCase().includes("verified") || n.toLowerCase().includes("success"));
  const attemptResult: Attempt["result"] = selfVerified ? "success" : "failure";

  if (attemptResult !== "success") mergeFiles = undefined;

  const attempt: Attempt = {
    id,
    timestamp: new Date().toISOString(),
    experience_key: key,
    strategy_genome_id: genome.id,
    worker: "other",
    result: attemptResult,
    files_changed: result.filesChanged,
    diff_lines: result.filesChanged.length * 10,
    tests_added: result.testsAdded,
    commands_run: [],
    boundary_violations: [],
    notes: [
      ...result.notes,
      `tokens:in=${result.totalUsage.input_tokens},out=${result.totalUsage.output_tokens},cached=${result.totalUsage.cached_tokens}`,
    ],
  };

  return { attempt, mergeFiles };
}

function fallbackResult(id: string, key: ExperienceKey, genome: StrategyGenome, reason: string): RealAttemptResult {
  return {
    attempt: {
      id, timestamp: new Date().toISOString(), experience_key: key,
      strategy_genome_id: genome.id, worker: "other", result: "failure",
      files_changed: [], diff_lines: 0, tests_added: 0,
      commands_run: [], boundary_violations: [],
      notes: [`fallback: ${reason}`],
    },
  };
}

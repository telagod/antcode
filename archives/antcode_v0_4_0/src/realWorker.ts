import { Attempt, ExperienceKey, StrategyGenome } from "./types";
import { RealTask } from "./tasks";
import { createLocalOps, ALL_TOOLS, toolsToSchema, buildToolSnippets, ToolDef, AllOps } from "./tools";
import { gatherInsights, formatInsightsForPrompt } from "./insights";
import { AgentAssignment, buildFocusPrompt, recordDiscovery, formatDiscoveriesForPrompt } from "./collaboration";
import path from "node:path";

const BASE_URL = process.env.ANTCODE_LLM_BASE_URL ?? "https://sub.foxnio.com/v1";
const API_KEY = process.env.ANTCODE_LLM_API_KEY ?? "";
const MODEL = process.env.ANTCODE_LLM_MODEL ?? "gpt-5.4";

let attemptCounter = 0;

// === System prompt — stable prefix for cache hit ===
const SYSTEM_PROMPT = `You are a code improvement agent. You explore a TypeScript project, find concrete issues, fix them, and verify your fixes.

## Available Tools
${buildToolSnippets(ALL_TOOLS)}

## Workflow
1. Start with ls and find to understand the project structure
2. Read specific files to find concrete issues (bugs, missing error handling, type errors, dead code, missing exports)
3. Pick ONE specific issue to fix — be precise (e.g. "readJson on line 12 doesn't handle malformed JSON")
4. Fix it with edit (preferred) or write
5. Run bash to verify your fix (e.g. "npx tsc --noEmit", "npx tsx src/cli.ts run-experiment 1")
6. If verification fails, fix and re-verify
7. Call done with a specific summary of what you fixed and how you verified it

## Rules
- Fix ONE concrete issue per session, not multiple
- Use edit for targeted changes, write only for new files
- Always verify with bash before calling done
- If you can't find any issues, call done with notes explaining why
- Be specific in done notes: "Fixed readJson to catch JSON.parse errors" not "Hardened error handling"`;

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

// compress old tool results to reduce input tokens while keeping prefix stable
function compressHistory(messages: Array<Record<string, unknown>>): void {
  const KEEP_RECENT = 6; // keep last N messages fully intact
  if (messages.length <= KEEP_RECENT + 1) return;

  const cutoff = messages.length - KEEP_RECENT;
  for (let i = 1; i < cutoff; i++) {
    const msg = messages[i];

    if (msg.type === "function_call_output" && typeof msg.output === "string") {
      const out = msg.output as string;

      // read/grep results: keep only first 50 lines
      if (out.includes("\t") && out.length > 500) {
        const lines = out.split("\n");
        msg.output = lines.slice(0, 50).join("\n") + (lines.length > 50 ? `\n... (${lines.length - 50} more lines)` : "");
      }
      // bash results: keep exit code + first 20 lines
      else if (out.startsWith("exit=")) {
        const lines = out.split("\n");
        msg.output = lines.slice(0, 20).join("\n") + (lines.length > 20 ? `\n... (${lines.length - 20} more lines)` : "");
      }
      // everything else: hard cap at 100 chars
      else if (out.length > 100) {
        msg.output = out.slice(0, 80) + `... (${out.length - 80} chars)`;
      }
    }

    // compress function_call arguments (remove large content args from old write/edit calls)
    if (msg.type === "function_call" && typeof msg.arguments === "string") {
      const args = msg.arguments as string;
      if (args.length > 300) {
        try {
          const parsed = JSON.parse(args);
          if (parsed.content && parsed.content.length > 100) {
            parsed.content = parsed.content.slice(0, 80) + "... (truncated)";
            msg.arguments = JSON.stringify(parsed);
          }
          if (parsed.edits) {
            parsed.edits = parsed.edits.map((e: { oldText: string; newText: string }) => ({
              oldText: e.oldText?.slice(0, 40) + "...",
              newText: e.newText?.slice(0, 40) + "...",
            }));
            msg.arguments = JSON.stringify(parsed);
          }
        } catch { /* keep original */ }
      }
    }
  }
}

function cacheKeyForTask(taskDesc: string): string {
  let hash = 0;
  for (let i = 0; i < taskDesc.length; i++) {
    hash = ((hash << 5) - hash + taskDesc.charCodeAt(i)) | 0;
  }
  return `antcode-${Math.abs(hash).toString(36)}`;
}

async function runToolLoop(
  input: string,
  ops: AllOps,
  cwd: string,
  taskCacheKey?: string,
): Promise<{ notes: string[]; testsAdded: number; totalUsage: Usage; filesChanged: string[]; bashResults: string[] }> {
  const notes: string[] = [];
  let testsAdded = 0;
  const totalUsage: Usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
  const filesChanged = new Set<string>();
  const bashResults: string[] = [];

  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: input },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // compress old rounds to reduce input tokens
    compressHistory(messages);

    const isLastRound = round === MAX_TOOL_ROUNDS - 1;
    const body: Record<string, unknown> = {
      model: MODEL, instructions: SYSTEM_PROMPT, input: messages,
      tools: TOOL_SCHEMAS, stream: true,
      tool_choice: isLastRound ? { type: "function", name: "done" } : "auto",
      ...(taskCacheKey ? { prompt_cache_key: taskCacheKey } : {}),
    };


    let result: StreamResult;
    try {
      result = await streamOnce(body);
    } catch (e) {
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

    console.log(`      r${round}: ${result.toolCalls.map(tc => tc.name).join(", ")}`);

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
      if (tc.name === "bash") bashResults.push(res.output);
      if (res.isDone) { notes.push(...res.notes); testsAdded = res.testsAdded; isDone = true; }
    }

    if (isDone) break;
  }

  return { notes, testsAdded, totalUsage, filesChanged: [...filesChanged], bashResults };
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
  assignment?: AgentAssignment,
): Promise<RealAttemptResult> {
  attemptCounter += 1;
  const id = `attempt_${String(attemptCounter).padStart(4, "0")}`;

  const { createSlot, resetSlot, cleanupSlot } = await import("./verify");
  const slot = createSlot(slotId);
  resetSlot(slot);

  const ops = createLocalOps(slot);
  const insights = formatInsightsForPrompt(gatherInsights(process.cwd(), key.goal_pattern));

  // build input: focus area + shared discoveries + strategy + insights
  const focusPrompt = assignment ? buildFocusPrompt(assignment) : "";
  const discoveries = formatDiscoveriesForPrompt();
  const goalHint = task
    ? `## Task\n${task.description}`
    : `## Goal\nImprove code quality in this TypeScript project. Look for: missing error handling, type safety issues, dead code, missing exports, or code that could be cleaner.`;

  const input = [
    goalHint,
    focusPrompt,
    discoveries,
    `## Strategy (${genome.id})\n- prefer_existing_pattern: ${genome.action_strategy.prefer_existing_pattern}\n- forbid_architecture_change: ${genome.action_strategy.forbid_architecture_change}\n- validation: ${genome.validation_strategy.required.join(", ")}`,
    insights,
  ].filter(Boolean).join("\n\n");

  const taskCacheKey = cacheKeyForTask(goalHint + (assignment?.focusArea ?? ""));

  let result: Awaited<ReturnType<typeof runToolLoop>>;
  try {
    result = await runToolLoop(input, ops, slot, taskCacheKey);
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

  // determine success: files changed + bash verification or done called
  const hasFileChanges = result.filesChanged.length > 0;
  const calledDone = result.notes.length > 0;
  const lastBashPassed = result.bashResults.length > 0 && result.bashResults[result.bashResults.length - 1].startsWith("exit=0");
  const notesIndicateSuccess = result.notes.some((n) => {
    const l = n.toLowerCase();
    return l.includes("pass") || l.includes("verified") || l.includes("success") || l.includes("complete") || l.includes("done") || l.includes("fixed");
  });

  let attemptResult: Attempt["result"] = "failure";
  if (hasFileChanges && (calledDone || lastBashPassed || notesIndicateSuccess)) {
    attemptResult = "success";
  } else if (hasFileChanges) {
    attemptResult = "blocked";
  }

  if (attemptResult !== "success") mergeFiles = undefined;

  // record discoveries for other agents
  for (const f of result.filesChanged) {
    const summary = result.notes.slice(0, 2).join("; ").slice(0, 100) || `modified ${f}`;
    recordDiscovery({
      agentId: assignment?.agentId ?? 0,
      timestamp: new Date().toISOString(),
      file: f,
      finding: summary,
      fixed: attemptResult === "success",
    });
  }

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

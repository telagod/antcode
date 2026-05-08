import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { Message } from "@mariozechner/pi-ai";
import { ALL_TOOLS } from "../tools";
import type { AllOps, ToolDef } from "../tools";
import { createPiModel, API_KEY } from "./piModel";
import { SYSTEM_PROMPT } from "./prompt";
import { createRuntimeTelemetry } from "./observability";
import type { AgentRunInput, AgentRunResult, AgentRuntime, TokenUsage } from "./types";

const AGENT_TIMEOUT_MS = Number(process.env.ANTCODE_AGENT_TIMEOUT_MS ?? 300000);
const AGENT_ABORT_GRACE_MS = Number(process.env.ANTCODE_AGENT_ABORT_GRACE_MS ?? 2000);
const MAX_TOOL_CALLS = Number(process.env.ANTCODE_MAX_TOOL_CALLS ?? 20);

function toUsage(usage: unknown): TokenUsage {
  const u = usage as { input?: number; output?: number; cacheRead?: number } | undefined;
  return {
    input_tokens: u?.input ?? 0,
    output_tokens: u?.output ?? 0,
    cached_tokens: u?.cacheRead ?? 0,
  };
}

function addUsage(total: TokenUsage, usage: TokenUsage): void {
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.cached_tokens += usage.cached_tokens;
}

function makePiTool(def: ToolDef, ops: AllOps, cwd: string, state: {
  notes: string[];
  testsAdded: number;
  filesChanged: Set<string>;
  bashResults: string[];
  toolCount: number;
  isTimedOut: () => boolean;
  remainingMs: () => number;
}): AgentTool<any, { name: string }> {
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: Type.Unsafe(def.parameters),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      if (state.isTimedOut()) {
        return {
          content: [{ type: "text", text: "error: agent deadline exceeded before tool execution" }],
          details: { name: def.name, blocked: true },
          terminate: true,
        };
      }

      const args = (params ?? {}) as Record<string, unknown>;

      // done → signal completion
      if (def.name === "done") {
        state.notes.push(...(Array.isArray(args.notes) ? args.notes.map(String) : []));
        state.testsAdded = typeof args.tests_added === "number" ? args.tests_added : 0;
        return {
          content: [{ type: "text", text: "done" }],
          details: { name: def.name },
          terminate: true,
        };
      }

      // bash → fast commands run immediately; slow build/test/typecheck commands also run
      // immediately (synchronously) so the agent gets real feedback and won't make
      // cascading bad edits without knowing the build state.
      // The original "queue and flush on done" approach breaks the feedback loop —
      // the agent queues bash, gets immediate fake success, keeps editing blindly,
      // then all queued bash run too late to纠正 anything.
      if (def.name === "bash") {
        const rawCommand = String(args.command ?? "");
        const normalized = rawCommand.toLowerCase();
        const isBlocked = (normalized.includes("run-experiment") || normalized.includes("demo:real"))
          && (normalized.includes("--real") || normalized.includes("demo:real"));
        if (isBlocked) {
          return { content: [{ type: "text", text: "exit=126\nblocked: nested real AntCode runs are not allowed from inside a workbench" }], details: { name: "bash" } };
        }
        const requestedTimeout = typeof args.timeout === "number" ? args.timeout : 60000;
        const cappedTimeout = Math.max(1000, Math.min(requestedTimeout, state.remainingMs() - 500));
        try {
          const { exitCode, stdout, stderr } = ops.exec(rawCommand, cwd, cappedTimeout);
          const out = [stdout, stderr].filter(Boolean).join("\n").slice(0, 4000);
          state.bashResults.push(`exit=${exitCode}\n${out}`);
          return { content: [{ type: "text", text: `exit=${exitCode}\n${out}` }], details: { name: "bash" } };
        } catch (e: unknown) {
          const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
          const out = [err.stdout?.toString(), err.stderr?.toString(), err.message].filter(Boolean).join("\n").slice(0, 4000);
          state.bashResults.push(`exit=${err.status ?? 1}\n${out}`);
          return { content: [{ type: "text", text: `exit=${err.status ?? 1}\n${out}` }], details: { name: "bash" } };
        }
      }

      // fast tools: run immediately
      const output = def.execute(args, ops, cwd);
      if (def.name === "write" || def.name === "edit") {
        if (typeof args.path === "string") state.filesChanged.add(args.path);
      }
      return {
        content: [{ type: "text", text: output }],
        details: { name: def.name },
      };
    },
  };
}

export class PiAgentRuntime implements AgentRuntime {
  async run({ input, ops, cwd, cacheKey }: AgentRunInput): Promise<AgentRunResult> {
    if (!API_KEY) throw new Error("ANTCODE_LLM_API_KEY is required for pi real LLM mode");

    const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
    const deadlineAt = Date.now() + AGENT_TIMEOUT_MS;
    const telemetryControl = createRuntimeTelemetry(AGENT_TIMEOUT_MS);
    const state = {
      notes: [] as string[],
      testsAdded: 0,
      filesChanged: new Set<string>(),
      bashResults: [] as string[],
      toolCount: 0,
      isTimedOut: () => Date.now() >= deadlineAt,
      remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: createPiModel(),
        thinkingLevel: "off",
        tools: ALL_TOOLS.map((tool) => makePiTool(tool, ops, cwd, state)),
        messages: [],
      },
      convertToLlm: (messages): Message[] => messages.filter((message): message is Message => {
        return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
      }),
      getApiKey: () => API_KEY,
      sessionId: cacheKey,
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall, args }) => {
        if (state.isTimedOut()) {
          telemetryControl.record("tool_blocked", `${toolCall.name}: deadline exceeded`);
          return { block: true, reason: "agent deadline exceeded before tool execution" };
        }
        // max tools limit: force done when limit is reached
        if (toolCall.name !== "done") {
          state.toolCount += 1;
          if (state.toolCount > MAX_TOOL_CALLS) {
            telemetryControl.record("tool_blocked", `${toolCall.name}: max ${MAX_TOOL_CALLS} tools reached`);
            // force signal done to stop the agent
            state.notes.push(`[forced done: max ${MAX_TOOL_CALLS} tool calls reached]`);
            return { terminate: true };
          }
        }
        if (toolCall.name === "bash") {
          const command = String((args as { command?: unknown }).command ?? "").toLowerCase();
          if ((command.includes("run-experiment") || command.includes("demo:real")) && (command.includes("--real") || command.includes("demo:real"))) {
            telemetryControl.record("tool_blocked", "bash: nested real AntCode run");
            return { block: true, reason: "nested real AntCode runs are not allowed from inside a workbench" };
          }
        }
        return undefined;
      },
      afterToolCall: async ({ toolCall }) => {
        telemetryControl.record("tool_end", toolCall.name);
        if (toolCall.name === "done") return { terminate: true };
        return undefined;
      },
      maxRetryDelayMs: 5000,
    });

    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        addUsage(totalUsage, toUsage(event.message.usage));
        const text = event.message.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("");
        telemetryControl.record("message_end", `assistant tokens in=${event.message.usage.input} out=${event.message.usage.output}`);
        if (text && state.notes.length === 0) state.notes.push(text.slice(0, 200));
      }
      if (event.type === "tool_execution_start") {
        telemetryControl.record("tool_start", event.toolName);
        console.log(`      pi: ${event.toolName} +${telemetryControl.elapsed()}ms`);
      }
    });

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        telemetryControl.record("timeout", `agent exceeded ${AGENT_TIMEOUT_MS}ms; aborting`);
        agent.abort();
        graceTimer = setTimeout(() => {
          reject(new Error(`pi agent run timed out after ${AGENT_TIMEOUT_MS}ms and did not settle within ${AGENT_ABORT_GRACE_MS}ms abort grace`));
        }, AGENT_ABORT_GRACE_MS);
      }, AGENT_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        (async () => {
          await agent.prompt(input);
          await agent.waitForIdle();
        })(),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
    }

    const telemetry = telemetryControl.finish(timedOut);
    return {
      notes: state.notes,
      testsAdded: state.testsAdded,
      totalUsage,
      filesChanged: [...state.filesChanged],
      bashResults: state.bashResults,
      telemetry,
    };
  }
}

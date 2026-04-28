import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { Message } from "@mariozechner/pi-ai";
import { ALL_TOOLS } from "../tools";
import type { AllOps, ToolDef } from "../tools";
import { createPiModel, API_KEY } from "./piModel";
import { SYSTEM_PROMPT } from "./prompt";
import type { AgentRunInput, AgentRunResult, AgentRuntime, TokenUsage } from "./types";

const AGENT_TIMEOUT_MS = Number(process.env.ANTCODE_AGENT_TIMEOUT_MS ?? 45000);

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
}): AgentTool<any, { name: string }> {
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: Type.Unsafe(def.parameters),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const args = (params ?? {}) as Record<string, unknown>;
      if (def.name === "done") {
        state.notes.push(...(Array.isArray(args.notes) ? args.notes.map(String) : []));
        state.testsAdded = typeof args.tests_added === "number" ? args.tests_added : 0;
        return {
          content: [{ type: "text", text: "done" }],
          details: { name: def.name },
          terminate: true,
        };
      }

      const output = def.execute(args, ops, cwd);
      if (def.name === "write" || def.name === "edit") {
        if (typeof args.path === "string") state.filesChanged.add(args.path);
      }
      if (def.name === "bash") state.bashResults.push(output);
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
    const state = {
      notes: [] as string[],
      testsAdded: 0,
      filesChanged: new Set<string>(),
      bashResults: [] as string[],
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
        if (toolCall.name === "bash") {
          const command = String((args as { command?: unknown }).command ?? "").toLowerCase();
          if ((command.includes("run-experiment") || command.includes("demo:real")) && (command.includes("--real") || command.includes("demo:real"))) {
            return { block: true, reason: "nested real AntCode runs are not allowed from inside a workbench" };
          }
        }
        return undefined;
      },
      afterToolCall: async ({ toolCall }) => {
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
        if (text && state.notes.length === 0) state.notes.push(text.slice(0, 200));
      }
      if (event.type === "tool_execution_start") {
        console.log(`      pi: ${event.toolName}`);
      }
    });

    const timer = setTimeout(() => agent.abort(), AGENT_TIMEOUT_MS);
    try {
      await agent.prompt(input);
      await agent.waitForIdle();
    } finally {
      clearTimeout(timer);
    }

    return {
      notes: state.notes,
      testsAdded: state.testsAdded,
      totalUsage,
      filesChanged: [...state.filesChanged],
      bashResults: state.bashResults,
    };
  }
}

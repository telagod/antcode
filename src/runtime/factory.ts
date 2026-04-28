import { PiAgentRuntime } from "./piRuntime";
import type { AgentRuntime } from "./types";

export type AgentRuntimeKind = "pi";

export function getAgentRuntimeKind(): AgentRuntimeKind {
  const raw = (process.env.ANTCODE_RUNTIME ?? "pi").trim().toLowerCase();
  if (raw === "pi" || raw === "pi-agent" || raw === "pi-agent-core") return "pi";
  throw new Error(`Unsupported ANTCODE_RUNTIME: ${process.env.ANTCODE_RUNTIME}. AntCode now uses pi-agent-core as the single runtime scaffold; set ANTCODE_RUNTIME=pi or unset it.`);
}

export function createAgentRuntime(_kind: AgentRuntimeKind = getAgentRuntimeKind()): AgentRuntime {
  return new PiAgentRuntime();
}

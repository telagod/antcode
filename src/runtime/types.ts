import type { AllOps } from "../tools";
import type { RuntimeTelemetry } from "./observability";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

export interface AgentRunInput {
  input: string;
  ops: AllOps;
  cwd: string;
  cacheKey?: string;
}

export interface AgentRunResult {
  notes: string[];
  testsAdded: number;
  totalUsage: TokenUsage;
  filesChanged: string[];
  bashResults: string[];
  telemetry?: RuntimeTelemetry;
}

export interface AgentRuntime {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

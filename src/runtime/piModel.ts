import type { Model } from "@mariozechner/pi-ai";

export const BASE_URL = process.env.ANTCODE_LLM_BASE_URL ?? "http://45.87.155.39:3000";
export const API_KEY = process.env.ANTCODE_LLM_API_KEY ?? "";
export const MODEL = process.env.ANTCODE_LLM_MODEL ?? "claude-opus-4-7";
export const API_KIND = (process.env.ANTCODE_LLM_API ?? "anthropic-messages") as
  | "openai-completions"
  | "anthropic-messages";

export function createPiModel(): Model<typeof API_KIND> {
  return {
    id: MODEL,
    name: MODEL,
    api: API_KIND,
    provider: "antcode-pi",
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    compat: {
      supportsLongCacheRetention: true,
    },
  };
}

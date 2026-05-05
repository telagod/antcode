import type { Model } from "@mariozechner/pi-ai";

export const BASE_URL = process.env.ANTCODE_LLM_BASE_URL ?? "https://sub.foxnio.com/v1";
export const API_KEY = process.env.ANTCODE_LLM_API_KEY ?? "";
export const MODEL = process.env.ANTCODE_LLM_MODEL ?? "minimaxai/minimax-m2.7";

export function createPiModel(): Model<"openai-completions"> {
  return {
    id: MODEL,
    name: MODEL,
    api: "openai-completions",
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

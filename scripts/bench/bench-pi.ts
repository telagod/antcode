import { createPiModel, API_KEY } from "../../src/runtime/piModel";
import { completeSimple } from "@mariozechner/pi-ai";

async function bench() {
  const model = createPiModel();
  const runs: { elapsed: number; tokens: number; text: string }[] = [];

  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const msg = await completeSimple(
      model,
      {
        systemPrompt: "Reply with OK only",
        messages: [{ role: "user", content: "Say yes", timestamp: Date.now() }],
      },
      { apiKey: API_KEY, maxRetries: 1, timeoutMs: 60000 },
    );
    const elapsed = Date.now() - t0;
    const text = msg.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    const tokens = msg.usage.totalTokens;
    runs.push({ elapsed, tokens, text: text.slice(0, 30) });
    console.log(`Run ${i + 1}: ${elapsed}ms, ${tokens} tokens, reply: "${text}"`);
  }

  const avgMs = runs.reduce((a, r) => a + r.elapsed, 0) / runs.length;
  const avgTokens = runs.reduce((a, r) => a + r.tokens, 0) / runs.length;
  console.log("---");
  console.log(`Model: ${model.id}`);
  console.log(`Avg latency: ${avgMs.toFixed(0)}ms`);
  console.log(`Avg tokens: ${avgTokens.toFixed(0)}`);
}

bench().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
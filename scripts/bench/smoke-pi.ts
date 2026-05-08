// Manual env load FIRST (before any imports of antcode modules)
import { readFileSync } from "fs";
import * as path from "path";
import { execSync } from "child_process";
const repoRoot = execSync("git rev-parse --show-toplevel").toString().trim();
const envText = readFileSync(path.join(repoRoot, ".env"), "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const piAi = await import("@mariozechner/pi-ai");
  const piModel = await import(path.join(repoRoot, "src/runtime/piModel"));
  const model = piModel.createPiModel();
  console.log("API:", model.api, "| Model:", model.id, "| Base:", model.baseUrl);
  console.log("KeyLen:", piModel.API_KEY.length);
  const res = await piAi.completeSimple(
    model,
    { messages: [{ role: "user", content: "Reply with just OK", timestamp: Date.now() } as any] },
    { apiKey: piModel.API_KEY }
  );
  console.log("Result:", JSON.stringify(res).slice(0, 500));
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });

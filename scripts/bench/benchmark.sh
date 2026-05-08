#!/bin/bash
# antcode-perf-bench.sh — measures slot creation, pi calls, patch verification latency

set -e
cd "$(git rev-parse --show-toplevel)"

echo "=== AntCode Performance Benchmark ==="
echo "Model: $ANTCODE_LLM_MODEL"
echo "Base URL: $ANTCODE_LLM_BASE_URL"
echo ""

# ── 1. Slot creation benchmark ──────────────────────────────────────────────
echo "--- [1] Slot creation (3 runs) ---"
SLOT_BENCHMARK=$(node -e "
const { createSlot, cleanupSlot } = require('./dist/verify.js');
const times = [];
for (let i = 0; i < 3; i++) {
  const t0 = Date.now();
  const slot = createSlot(i);
  const t1 = Date.now();
  times.push(t1 - t0);
  cleanupSlot(slot);
}
console.log(JSON.stringify(times));
" 2>/dev/null || echo "[]")

echo "Slot creation times (ms): $SLOT_BENCHMARK"
echo ""

# ── 2. Pi LLM call benchmark ─────────────────────────────────────────────────
echo "--- [2] Pi LLM call (3 runs, simple prompt) ---"
PI_BENCHMARK=$(npx tsx -e "
import { createPiModel, API_KEY } from './src/runtime/piModel';
import { completeSimple } from '@mariozechner/pi-ai';

async function bench() {
  const model = createPiModel();
  const times = [];
  const tokens = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const msg = await completeSimple(
      model,
      { systemPrompt: 'Reply with OK', messages: [{ role: 'user', content: 'Say yes', timestamp: Date.now() }] },
      { apiKey: API_KEY, maxRetries: 1, timeoutMs: 60000 }
    );
    const t1 = Date.now();
    const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
    times.push(t1 - t0);
    tokens.push(msg.usage.totalTokens);
    console.error('run', i, text.slice(0, 20), t1 - t0, 'ms', msg.usage.totalTokens, 'tokens');
  }
  process.stdout.write(JSON.stringify({ times, tokens }));
}

bench().catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null)

echo "Pi LLM call times (ms): $PI_BENCHMARK"
echo ""

# ── 3. TypeScript typecheck benchmark ───────────────────────────────────────
echo "--- [3] TypeScript typecheck (tsc --noEmit, 3 runs) ---"
TC_BENCHMARK=$(for i in 1 2 3; do
  t0=$(date +%s%3N)
  npx tsc --noEmit 2>/dev/null
  t1=$(date +%s%3N)
  echo $((t1 - t0))
done | paste -sd ' ')
echo "Typecheck times (ms): $TC_BENCHMARK"
echo ""

# ── 4. File I/O benchmark ───────────────────────────────────────────────────
echo "--- [4] File I/O (read 10 src/*.ts files, 3 runs) ---"
IO_BENCHMARK=$(node -e "
const fs = require('fs');
const path = require('path');
const files = fs.readdirSync('src').filter(f => f.endsWith('.ts')).slice(0, 10).map(f => 'src/' + f);
const times = [];
for (let i = 0; i < 3; i++) {
  const t0 = Date.now();
  for (const f of files) fs.readFileSync(f, 'utf8');
  times.push(Date.now() - t0);
}
console.log(JSON.stringify(times));
")
echo "File I/O times (ms): $IO_BENCHMARK"
echo ""

# ── 5. End-to-end mock iteration ────────────────────────────────────────────
echo "--- [5] Mock iteration (1 run, no LLM) ---"
MOCK_TIME=$(npx tsx src/cli.ts run-experiment 2 2>&1 | grep -E 'ran|took|ms' | head -5)
echo "$MOCK_TIME"
echo ""

echo "=== Benchmark complete ==="
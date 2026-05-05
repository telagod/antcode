# Changelog

## [0.8.3] — 2026-05-05

### Foundation (P0)
- **Reward system modularization**: Split `src/reward.ts` into `src/reward/calculator.ts`, `src/reward/weights.ts`, and `src/reward/calibrator.ts`.
- **Learned reward weights**: Replaced hard-coded magic numbers (`0.75`, `0.35`, `diff_lines / 1000`) with configurable `RewardWeights` persisted in `.antcode/reward-weights.json`.
- **Weight calibration**: Added moving-average auto-calibration that nudges weights based on historical (predicted vs actual) success correlation.
- **UCB1 + Thompson sampling**: Rewrote `src/sampler.ts` with exploitation (`scoreGenomeForSampling`), exploration bonus (`scoreGenomeUCB`), and Bayesian uncertainty (`scoreGenomeThompson` via Beta distribution).
- **Pheromone evaporation**: Negative pheromones now decay at `evaporation.negative` rate per sampling round.

### Engine (P1)
- **Mutation DSL**: Replaced 6 hard-coded `if-else` branches in `mutationOps.ts` with a declarative `MutationRecipe` system supporting 8 primitives: `set`, `toggle`, `prepend`, `push`, `dedupe`, `adjust`, `replace`, `clamp`, `downgrade_enum`, `use_evidence`.
- **Random exploration**: Added ε-greedy random safe mutations (`randomExplore`) with `exploration_rate` (default 5%) to escape local optima.
- **Dependency-aware crossover**: `crossover.ts` now respects module dependency graph (`context → boundary → action → validation`) with cohesion probability (0.4–0.7). Includes correlation matrix tracking between strategy fields and reward outcomes.

### Infrastructure (P2)
- **Copy-on-Write workspaces**: `src/workspace/cow.ts` auto-detects reflink-capable filesystems (Btrfs/XFS/APFS) and uses `COPYFILE_FICLONE` for <100ms slot creation. Falls back to normal copy.
- **In-memory diff calculation**: Replaced `execSync("git diff --no-index")` with `diff` npm package LCS, removing ~50–100ms per-file process overhead.
- **Incremental TypeScript compilation**: `runTypecheck` now passes `--incremental --tsBuildInfoFile` to reuse previous typecheck state.
- **Buffered JSONL storage**: `BufferedStorage` in `src/storage.ts` batches writes in memory (flush every 50 lines / 5s), reducing `appendJsonl` syscall overhead by ~100x.

### Parallelism (P3)
- **WorkerPool**: New `src/worker/pool.ts` manages concurrent LLM tasks with configurable concurrency, rate-limit backoff/retry (2s × retries), and slot allocation. Replaces ad-hoc `Promise.allSettled`.

### Intelligence (P4)
- **Embedding similarity matching**: `src/embeddings/client.ts` provides dual-mode semantic matching:
  - **FoxNIO API**: OpenAI-compatible embedding endpoint (moonshotai/Kimi-K2.6 via `ANTCODE_LLM_API_KEY`).
  - **Local fallback**: Character bigram Jaccard + 16-dim histogram embedding for offline operation.
  `sampleGenome` now tries exact → fuzzy → **semantic similarity >0.8** → broad fallback.
- **Strategy export/import CLI**: New commands `export-strategies [--top-k=n]` and `import-strategies <file>` enable cross-project knowledge transfer. Exported genomes are compacted (stripped of attempts).

### Compatibility
- All existing tests pass unchanged.
- `npm test` green across all 7 test suites.
- `npx tsc --noEmit` zero errors.

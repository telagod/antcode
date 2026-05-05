# AntCode v0.8.3 Optimization Plan
## Target: Evolution Engine + I/O Efficiency + LLM-Assisted Mutation
### LLM Backend: Kimi-K2.6 via FoxNIO API
### Date: 2026-05-05

---

## Phase Overview

| Phase | Focus | Est. Time | LLM Usage |
|-------|-------|-----------|-----------|
| P0 | Foundation: Reward calibration + UCB sampling | 2-3h | Design review + code gen |
| P1 | Engine: Adaptive mutation + crossover | 3-4h | DSL design + prompt engineering |
| P2 | Infra: COW workspaces + incremental builds | 2-3h | Script/tool integration |
| P3 | Parallel: Multi-slot worker pool | 2h | Coordination logic |
| P4 | Intelligence: Embedding similarity + knowledge transfer | 3-4h | Embedding API calls |

---

## P0. Foundation: Stop Hard-Coding Evolution Parameters

### P0-1. Reward Function: From Magic Numbers to Learned Weights
**Current**: `reward.ts` has fixed weights (`success ? 0.75 : 0.35`, `diffPenalty = diff_lines / 1000`)
**Problem**: These weights are hand-tuned for one type of task. They don't adapt.

**Plan**:
1. Extract all reward weights into a `RewardWeights` interface
2. Add `reward-weights.json` state file in `.antcode/`
3. Implement `calibrateRewardWeights()` that uses historical (Attempt, Reward, Outcome) data
4. Use linear regression (or even just moving average) to auto-adjust weights based on which weight combinations predict actual success

**Files to modify**:
- `src/reward.ts` → refactor into `src/reward/calculator.ts` + `src/reward/weights.ts`
- `src/storage.ts` → add `reward-weights.json` read/write
- New: `src/reward/calibrator.ts`

**LLM Task**: Generate the calibrator logic. Prompt: "Write a TypeScript function that takes historical reward bundles and outcomes, then uses simple linear regression to find optimal weights for success prediction. The weights should be constrained to [0, 1] and sum to 1 for the base components."

### P0-2. Sampler: Roulette → UCB1-Thompson Hybrid
**Current**: `sampler.ts` uses weighted roulette wheel. No exploration bonus.
**Problem**: Gets stuck on locally optimal strategies, never discovers better ones.

**Plan**:
1. Keep `scoreGenomeForSampling()` as the exploitation score
2. Add UCB1 bonus: `ucb_score = avg_reward + sqrt(2 * ln(total_samples) / genome_samples)`
3. For genomes with < 3 samples, use Thompson Sampling: sample from Beta(successes+1, failures+1)
4. Add `evaporation` to negative pheromones (currently ignored): `penalty *= exp(-lambda * days_since_update)`

**Files to modify**:
- `src/sampler.ts` → add UCB + Thompson + evaporation
- `src/types.ts` → add `BetaDistribution` to `StrategyPheromone`

**LLM Task**: Verify the UCB1 + Thompson hybrid formula. Ask Kimi to review the math.

---

## P1. Engine: Make Mutation a DSL, Not Hard-Coded If-Else

### P1-1. Mutation DSL: StrategyGenome Describes Its Own Mutation Rules
**Current**: `mutationOps.ts` has 6 hard-coded `if-else` branches. Adding a new failure mode means editing source code.
**Problem**: The agent can't evolve its own mutation strategies.

**Plan**:
1. Extend `StrategyGenome.mutation_policy` from `Array<{if_failure_mode, mutate: string[]}>` to a real DSL
2. DSL primitives:
   - `adjust(field, delta, min, max)` - numeric tweak
   - `toggle(field)` - boolean flip
   - `prepend(field, value)` - array prepend
   - `replace(field, from, to)` - string substitution
   - `compound([...])` - multiple mutations
3. `applyOneMutation()` becomes an interpreter over this DSL
4. Default policies are loaded from JSON, not hard-coded

**Files to modify**:
- `src/types.ts` → expand `MutationPolicy` type
- `src/mutationOps.ts` → rewrite as DSL interpreter
- New: `src/mutation/dsl.ts` + `src/mutation/interpreter.ts`
- New: `templates/default-mutation-policies.json`

**LLM Task**: Generate the DSL schema and interpreter. Prompt: "Design a JSON-based mutation DSL for an evolutionary algorithm. The DSL should allow adjusting numeric fields, toggling booleans, and prepending to arrays. Write the TypeScript type definitions and a simple interpreter."

### P1-2. Mutation: Add Random Exploration (ε-Greedy for Strategies)
**Current**: Mutations are purely reactive (triggered by failure). No random creative exploration.
**Problem**: Local optima trap.

**Plan**:
1. Add `exploration_rate` to `PolicyConfig` (default 0.05)
2. Before checking failure modes, roll dice: if rand() < exploration_rate, apply a random valid mutation
3. Random mutations are from a curated safe set (e.g., +/- 1 on max_files, toggle scout_first)

**Files to modify**:
- `src/mutation.ts` → add `exploreRandomly()`
- `src/types.ts` → add `exploration_rate` to `PolicyConfig`

### P1-3. Crossover: Dependency-Aware Module Selection
**Current**: `crossover.ts` picks the "better" parent for each module independently.
**Problem**: `context_strategy.max_files` and `boundary_strategy.max_diff_lines` are correlated. Picking them from different parents creates invalid combinations.

**Plan**:
1. Define module dependency graph: `context → boundary → action → validation`
2. When crossing over, if parent A is chosen for `context_strategy`, it has higher probability (0.7) of being chosen for `boundary_strategy` too
3. Add correlation tracking: maintain `correlation_matrix.json` that learns which strategy fields co-vary with success

**Files to modify**:
- `src/crossover.ts` → add dependency-aware selection
- New: `src/crossover/correlation.ts`

---

## P2. Infra: Eliminate I/O Bottlenecks

### P2-1. Copy-on-Write Workspaces (Linux Focus)
**Current**: `verify.ts` `fs.cpSync(src, dst, { recursive: true })` copies entire `src/` tree for every experiment.
**Problem**: O(n) slot creation. For 100 experiments, this is >10s of pure copying.

**Plan**:
1. Detect filesystem: if Btrfs/XFS/ZFS, use `cp --reflink=auto`
2. If overlayfs available, use `mount -t overlay` with `lowerdir=project_root,upperdir=slot_workdir`
3. Fallback to current copy behavior
4. Benchmark: compare slot creation time before/after

**Files to modify**:
- `src/verify.ts` → `createSlot()` gets COW path
- New: `src/workspace/cow.ts`

**LLM Task**: Generate the COW detection and mounting logic. Prompt: "Write TypeScript functions to detect if a Linux filesystem supports reflink copies (Btrfs/XFS) and to create overlayfs mounts. Include fallback to regular copy."

### P2-2. Incremental TypeScript Compilation
**Current**: `runTypecheck()` calls `npx tsc --noEmit` from scratch every time.
**Problem**: Cold start typecheck is ~3-5s even for small projects.

**Plan**:
1. Use `tsc --incremental --tsBuildInfoFile .antcode/.tsbuildinfo`
2. Cache `.tsbuildinfo` per slot, or better: share one `.tsbuildinfo` across slots (read-only, each slot copies on first modification)
3. If project uses `tsc --build` (project references), use that instead

**Files to modify**:
- `src/verify.ts` → `runTypecheck()` add incremental flags

### P2-3. In-Memory Diff Calculation
**Current**: `countDiffLines()` spawns `git diff --no-index` process.
**Problem**: Process spawn overhead ~50-100ms per diff.

**Plan**:
1. Use `diff` npm package (or write a simple LCS diff)
2. Calculate diff lines in memory
3. Only fall back to `git diff` for complex binary files

**Files to modify**:
- `src/verify.ts` → replace `execSync("git diff")` with in-memory diff

### P2-4. Storage: Write Buffer + Index
**Current**: Every `appendJsonl()` opens, writes one line, closes the file.
**Problem**: syscall storm. 1000 attempts = 1000 open/write/close cycles.

**Plan**:
1. Add `BufferedStorage` class that buffers writes in memory (Map<file, lines[]>)
2. Auto-flush every 5s or every 50 lines
3. Add `closeAll()` for clean shutdown
4. For reads: maintain in-memory index `Map<strategy_id, file_offsets[]>`

**Files to modify**:
- `src/storage.ts` → add `BufferedStorage`
- `src/cli.ts` → add flush on exit

---

## P3. Parallel Execution: Multi-Slot Worker Pool

### P3-1. True Concurrent Workers
**Current**: `cli.ts` runs experiments sequentially. `realWorker.ts` uses single `slotId = 0`.
**Problem**: If LLM API call takes 30s, nothing else happens.

**Plan**:
1. Rewrite `runExperiment()` in `cli.ts` to use `Promise.all()` with limited concurrency
2. Pool size = `Math.min(CONCURRENCY, MAX_ACTIVE_SLOTS)` (currently CONCURRENCY=3, MAX_SLOTS=4)
3. Each worker gets its own slot, but `sharedRecon` is computed once and cached
4. Add `WorkerPool` class with queue management

**Files to modify**:
- `src/cli.ts` → refactor experiment loop to async pool
- New: `src/worker/pool.ts`

**LLM Task**: Generate the worker pool. Prompt: "Write a TypeScript WorkerPool class that manages N concurrent workers. Each worker runs an async task with a slot ID. The pool should queue tasks, execute up to N at a time, and return results as they complete."

### P3-2. Runtime Cache Optimization
**Current**: `cacheKeyForTask()` in `realWorker.ts` uses `recon + goalHint`, but prompt includes dynamic insights.
**Problem**: Cache never hits because insights change every run.

**Plan**:
1. Split prompt into `static_prompt` (recon + strategy + goal) and `dynamic_prompt` (insights + discoveries)
2. Cache key = hash(static_prompt only)
3. Dynamic part is appended after cache lookup
4. This requires runtime support from `pi-agent-core` - check if possible

**Files to modify**:
- `src/realWorker.ts` → split static/dynamic prompt parts
- `src/runtime/cache.ts` → already exists, verify it's being used correctly

---

## P4. Intelligence: Semantic Experience Keys + Knowledge Transfer

### P4-1. Embedding-Based Experience Key Matching
**Current**: `sampler.ts` exact matches on `goal_pattern` string, then falls back to any active genome.
**Problem**: "fix_type_error" and "fix_ts_error" are treated as completely different, even though they're the same thing.

**Plan**:
1. Use Kimi-K2.6 (or local MiniLM) to embed goal_pattern + module_region
2. Store embeddings in `.antcode/experience-embeddings.jsonl`
3. `sampleGenome()` first tries exact match, then cosine similarity > 0.85, then any active
4. This allows cross-task strategy transfer

**Files to modify**:
- `src/sampler.ts` → add `findByEmbedding()`
- New: `src/embeddings/client.ts` (FoxNIO API wrapper)
- New: `src/embeddings/store.ts`

**LLM Task**: Generate the embedding client. Prompt: "Write a TypeScript class EmbeddingClient that calls an OpenAI-compatible API for text embeddings. The API base URL and key come from env vars. Include cosine similarity calculation and a simple in-memory store with JSONL persistence."

### P4-2. Strategy Genome Export/Import (Cross-Project Transfer)
**Current**: Genomes are locked in one project.
**Problem**: Can't pre-seed a new project with evolved strategies.

**Plan**:
1. Add `antcode export-strategies --top-k 5` CLI command
2. Export compacts genomes: removes attempts, keeps only strategy DNA + stats
3. Add `antcode import-strategies <file>` to merge into current population
4. Imported genomes start as `candidate` status

**Files to modify**:
- `src/cli.ts` → add `export-strategies` and `import-strategies` commands
- `src/storage.ts` → add export/import helpers

### P4-3. TUI Dashboard (Optional, Nice-to-Have)
**Current**: Only CLI text output.
**Problem**: Hard to visualize evolution progress in real-time.

**Plan**:
1. Use `blessed` or simple ANSI escape codes
2. Show: generation count, active genomes, current best strategy, reward curve, slot usage
3. Update every 5s during experiment run
4. Fallback to current text mode if not TTY

**Files to modify**:
- New: `src/tui/dashboard.ts`
- `src/cli.ts` → detect TTY, optionally start dashboard

---

## Execution Order & Milestones

```
Week 1 (Days 1-2): P0 + P2-3 + P2-4
  → Foundation + quick wins. Reward calibration + buffered storage + in-memory diff.
  → Expected impact: 2-3x speedup on experiment throughput.

Week 1 (Days 3-4): P1 + P2-1 + P2-2
  → Mutation DSL + COW workspaces + incremental tsc.
  → Expected impact: Evolution quality improves, slot creation <100ms.

Week 2 (Days 5-6): P3 + P4-1
  → Parallel workers + embedding similarity.
  → Expected impact: 5-10x throughput, cross-task strategy transfer.

Week 2 (Day 7): P4-2 + Polish
  → Strategy export/import + TUI + comprehensive tests.
  → Expected impact: Production-ready, reusable across projects.
```

---

## Testing Strategy

1. **Unit tests**: Every new module gets a `*.test.ts` file (follow existing pattern)
2. **Benchmark harness**: Add `npm run benchmark` that measures:
   - Slot creation time (target: <100ms with COW)
   - Experiment throughput (target: >10 experiments/minute with parallel workers)
   - Evolution convergence (target: avg reward increases monotonically for 50 generations)
3. **Regression tests**: Ensure `npm test` still passes after each phase

---

## Dependencies to Add

| Package | Phase | Purpose |
|---------|-------|---------|
| `diff` | P2-3 | In-memory diff calculation |
| `blessed` (optional) | P4-3 | TUI dashboard |
| No new runtime deps for P0, P1, P3 | - | Pure TypeScript refactoring |

---

## LLM Usage Plan (Kimi-K2.6 via FoxNIO)

| Task | Tokens Est. | Approach |
|------|-------------|----------|
| Reward calibrator logic | ~2k | Single prompt, generate function |
| Mutation DSL schema + interpreter | ~3k | Two prompts: schema first, then interpreter |
| COW workspace detection | ~1.5k | Single prompt, generate OS detection |
| Worker pool class | ~1.5k | Single prompt |
| Embedding client | ~1k | Single prompt |
| Cross-cutting review | ~2k per phase | After each phase, ask Kimi to review the diff |

**Total LLM-assisted code**: ~15-20k tokens across all phases.
**Cost**: Negligible on FoxNIO (moonshotai/Kimi-K2.6 is very cheap).

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Mutation DSL too complex | Start with 4 primitives only. Add more if needed. |
| COW not available on user's FS | Always fallback to copy. No breaking change. |
| Parallel workers exhaust API rate limit | Add rate limiter in WorkerPool. Respect 429/Retry-After. |
| Embedding API latency | Cache embeddings in memory. Only compute for new keys. |
| Regression in existing tests | Run full test suite after every PR. Never skip tests. |

---

## Success Metrics

| Metric | Current | Target (P0-P4) |
|--------|---------|----------------|
| Slot creation time | ~500ms | <100ms (with COW) |
| Experiment throughput | ~2/min | >10/min (parallel) |
| Reward function adaptivity | None | Auto-calibrated weekly |
| Strategy sampling | Roulette | UCB + Thompson |
| Mutation rules | 6 hard-coded | DSL with 10+ primitives |
| Cross-task transfer | None | Embedding similarity >0.8 |
| Test coverage | N/A | Maintain or improve |

---

## Next Step

Ready to execute Phase 0 (P0-1: Reward calibration + P0-2: UCB sampling). 
Start with file reorganization: split `src/reward.ts` into `src/reward/` directory.

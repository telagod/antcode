# AntCode — Self-Evolving Code Agent

AntCode is an autonomous code improvement system that uses evolutionary strategies to guide LLM agents in finding and fixing issues in codebases. It evolves its own strategies over time, learning which approaches work best for different types of tasks.

## How It Works

```
┌─────────────────────────────────────────────────────┐
│                  Evolution Loop                      │
│                                                      │
│  1. Sample a Strategy Genome (weighted by fitness)   │
│  2. Spawn LLM Agent with tools (read/edit/bash/...)  │
│  3. Agent explores code, finds issue, fixes it       │
│  4. Agent self-verifies (typecheck, tests)           │
│  5. Calculate reward (semantic + cost + cache)        │
│  6. Update pheromones (positive/negative)            │
│  7. Maybe mutate strategy based on failure evidence   │
│  8. Tournament: promote winners, suppress losers     │
│  9. Merge successful changes back to source          │
│  10. Repeat                                          │
└─────────────────────────────────────────────────────┘
```

The system is inspired by ant colony optimization — strategies that succeed get stronger pheromone signals, strategies that fail get weaker. Failed strategies mutate to adapt, and child strategies compete with parents in tournaments.

## Quick Start

```bash
cd antcode_v0_5_0
npm install

# Run with mock worker (no LLM needed, tests evolution mechanics)
npm run demo

# Run with real LLM
export ANTCODE_LLM_BASE_URL="https://your-api.com/v1"
export ANTCODE_LLM_API_KEY="sk-..."
export ANTCODE_LLM_MODEL="gpt-4o"
npm run demo:real

# View results
npm run report
```

## CLI Commands

```bash
# Run experiment
npx tsx src/cli.ts run-experiment [iterations] [--real]

# View report (success rate, token usage, cost, strategy performance)
npx tsx src/cli.ts report

# Inspect state
npx tsx src/cli.ts show-genomes     # strategy genomes and their status
npx tsx src/cli.ts show-mutations   # mutation history
npx tsx src/cli.ts show-policy      # sampling probabilities per goal
npx tsx src/cli.ts show-health      # experience key health diagnostics
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTCODE_LLM_BASE_URL` | `https://sub.foxnio.com/v1` | OpenAI-compatible API base URL |
| `ANTCODE_LLM_API_KEY` | — | API key |
| `ANTCODE_LLM_MODEL` | `gpt-5.4` | Model ID |
| `ANTCODE_CONCURRENCY` | `3` | Parallel agents per batch |

## Architecture

```
src/
├── cli.ts              # CLI entry, experiment loop, report
├── tools/
│   ├── definitions.ts  # 8 universal tools (read/write/edit/bash/grep/find/ls/done)
│   ├── operations.ts   # I/O abstraction layer (swap for remote/docker/ssh)
│   └── index.ts
├── realWorker.ts       # LLM agent: tool loop, streaming, cache optimization
├── types.ts            # Core types (Genome, Attempt, Reward, Pheromone, etc.)
├── mutation.ts         # Mutation decision logic
├── mutationOps.ts      # Adaptive mutation operations
├── crossover.ts        # Gene crossover between strategies
├── tournament.ts       # Parent-child tournament
├── sampler.ts          # Pheromone-weighted genome sampling
├── reward.ts           # Reward calculation (semantic + cost + cache)
├── health.ts           # Experience key health diagnostics
├── collaboration.ts    # Multi-agent focus areas + shared discoveries
├── insights.ts         # Cross-attempt knowledge sharing
├── storage.ts          # JSONL file storage
├── verify.ts           # Workbench slot management + patch verification
├── simulator.ts        # Mock worker for testing evolution mechanics
├── taskGen.ts          # Dynamic task generation via LLM
└── tasks.ts            # Static task definitions
```

## Key Concepts

### Strategy Genome

A strategy genome defines how an LLM agent approaches a task:

- **context_strategy** — what to read, how many files, whether to scout first
- **action_strategy** — patch granularity, whether to prefer existing patterns
- **validation_strategy** — what checks to run before declaring success
- **boundary_strategy** — allowed file scope, max diff size
- **reward_profile** — what to optimize for, what to penalize
- **mutation_policy** — how to adapt when specific failure modes occur

### Pheromone System

Positive pheromones strengthen successful strategies. Negative pheromones mark failure patterns to avoid. Both evaporate over time to prevent lock-in.

### Adaptive Mutation

When a strategy fails repeatedly with the same failure mode, it mutates. Mutations are evidence-driven — if a boundary was too tight, the new value is derived from the actual diff size, not a blind multiplier.

### Tool Use Loop

In real mode, the LLM agent runs a multi-round tool loop:

```
round 0: ls, find          (explore project structure)
round 1: read, read, read  (understand relevant code)
round 2: grep              (search for patterns)
round 3: edit              (make targeted fix)
round 4: bash              (run typecheck/tests)
round 5: done              (report what was fixed)
```

The agent self-verifies its changes before completing. If verification fails, it can iterate.

### Operations Abstraction

All file/shell operations go through an `Operations` interface. The default implementation uses local `fs` and `execSync`, but you can swap it for:

- SSH operations (remote machine)
- Docker operations (containerized builds)
- Custom backends (any language, any platform)

## Performance

### Latest (v0.5.0 optimized, 12 rounds)

```
Success rate:     91.7% (11/12 attempts succeeded and merged)
Cache hit rate:   41.5%
Cost per attempt: $0.24
Avg reward:       0.656
Avg diff size:    16 lines
Genome convergence: 7 active / 4 candidate / 26 suppressed
```

### Evolution over time

| Phase | Rounds | Success | Cache | Cost/attempt |
|-------|--------|---------|-------|-------------|
| v0.4.0 pre-tooluse | 18 | 44% | 0% | $0.33 |
| v0.4.0 tool use | 12 | 50% | 15% | $0.13 |
| v0.5.0 initial | 30 | 57% | 48% | $0.16 |
| v0.5.0 + exploration timeout | 12 | 83% | 43% | $0.22 |
| v0.5.0 + shared recon | 12 | **92%** | 42% | $0.24 |

### Top Strategies

| Strategy | Success Rate | Avg Reward |
|----------|-------------|------------|
| refactor_big_bang_v4 | 100% (3/3) | 0.661 |
| scout_then_narrow_v2 | 100% (2/2) | 0.714 |
| refactor_big_bang_v6 | 100% (1/1) | 0.706 |
| refactor_big_bang_v3 | 100% (1/1) | 0.680 |
| test_first_minimal_v1 | 100% (1/1) | 0.678 |

### Code Self-Improved By LLM

Over the course of evolution, the LLM autonomously found and fixed:

- `storage.ts` — structured StorageError, tryReadJson/tryReadJsonl fallbacks
- `insights.ts` — safe JSONL reading, malformed file tolerance
- `verify.ts` — mergeToProject error handling, duplicate function removal
- `mutation.ts` — child strategy id derivation fix
- `mutationOps.ts` — context_underread change tracking, import tightening
- `crossover.ts` — JSON.parse clone → structuredClone
- `collaboration.ts` — discovery JSONL validation
- `taskGen.ts` — input validation, structured error handling
- `index.ts` — missing module exports (crossover, simulator, etc.)

## Version History

| Version | What Changed |
|---------|-------------|
| v0.3.2 | Mock-only MVP: strategy genome + mutation + tournament |
| v0.4.0 | Real LLM worker, concurrent execution, adaptive mutation, cost-aware reward |
| v0.5.0 | Universal tools, multi-round agent loop, autonomous exploration, multi-agent collaboration, 91.7% success rate |

## Project Structure

```
antcode/
├── README.md
├── antcode_v0_5_0/          # Current version
│   ├── src/                 # Source code
│   ├── .antcode/            # Evolution state (genomes, pheromones, policy)
│   ├── docs/                # Design documents
│   ├── schemas/             # JSON schemas
│   └── templates/           # YAML templates
└── archives/                # Previous versions
```

## License

MIT

<div align="center">

# AntCode

### Safe self-evolving code agent for TypeScript repositories

AntCode is an autonomous code-improvement system that learns which coding strategies work. It runs code agents in controlled workspaces, verifies their changes, scores the outcome, and evolves better strategies over time.

[![Release](https://img.shields.io/github/v/release/telagod/antcode?style=flat-square)](https://github.com/telagod/antcode/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/status-v0.8.0%20pi%20runtime-purple?style=flat-square)](https://github.com/telagod/antcode/releases/tag/v0.8.0)

</div>

---

## Why AntCode exists

Most code agents are stateless: they try a prompt, produce a patch, and forget what happened.

AntCode treats each attempt as training signal. A strategy that succeeds becomes more likely to run again; a strategy that fails is suppressed, mutated, or quarantined. The goal is not just to automate one patch — it is to make the agent better at choosing how to patch the next one.

```text
StrategyGenome
  -> Agent Attempt
  -> Verification
  -> RewardBundle
  -> Pheromone Update
  -> Mutation / Crossover / Tournament
  -> Better Sampling Policy
```

## What is new in v0.8.0

v0.8.0 is the runtime cleanup release. AntCode now keeps one clean agent runtime path on `pi-agent-core` instead of maintaining native Responses, OpenAI SDK, and AI SDK tool-loop forks.

```text
AntCode core
  -> strategy / reward / artifacts / tournament / workbench safety
  -> pi-agent-core runtime scaffold
  -> provider compatibility and tool execution plumbing
```

This keeps AntCode focused on its core product: learning which code-improvement strategies work and applying them safely.

## Features

- **Strategy genomes** — codified approaches for context reading, patch scope, validation, boundaries, reward, and mutation.
- **Pheromone-guided sampling** — successful strategies gain signal; repeated failures leave negative pheromones.
- **Real and mock workers** — run deterministic evolution simulations or real LLM tool loops.
- **Universal tools** — `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and `done`.
- **Safe patch artifacts** — pending changes are stored with manifests, patch diffs, copied files, and verification logs.
- **Review gates** — approve, reject, or roll back artifacts from the CLI.
- **Cost-aware reward** — tracks semantic confidence, diff size, token cost, cache hits, and guard flags.
- **Evolution mechanics** — mutation, crossover, tournament promotion, suppression, and quarantine.

## Quick start

```bash
git clone https://github.com/telagod/antcode.git
cd antcode
npm install
npm run init-state
npm run typecheck
npm test
npm run report
```

Run a mock evolution loop:

```bash
npm run demo
```

Run a real LLM-backed loop:

```bash
export ANTCODE_RUNTIME="pi" # optional; pi-agent-core is the single runtime scaffold
export ANTCODE_LLM_BASE_URL="https://your-openai-compatible-endpoint/v1"
export ANTCODE_LLM_API_KEY="sk-..."
export ANTCODE_LLM_MODEL="gpt-5.4"

npm run demo:real
```

## Safe self-modification workflow

Use this when you want AntCode to propose changes to itself without automatically merging them:

```bash
npx tsx src/cli.ts run-experiment 1 --real --no-auto-merge
npx tsx src/cli.ts review-attempt
npx tsx src/cli.ts review-attempt <attempt_id_or_artifact_id>
```

If the artifact looks good:

```bash
npx tsx src/cli.ts approve-attempt <attempt_id_or_artifact_id>
```

If it is wrong:

```bash
npx tsx src/cli.ts reject-attempt <attempt_id_or_artifact_id>
```

If an approved artifact needs to be undone:

```bash
npx tsx src/cli.ts rollback-attempt <attempt_id_or_artifact_id>
```

Artifact layout:

```text
.antcode/artifacts/<artifact_id>/
├── manifest.json
├── patch.diff
├── files/
└── verification.log
```

## CLI reference

| Command | Purpose |
|---|---|
| `run-experiment [n] [--real] [--no-auto-merge]` | Run mock or real evolution attempts |
| `review-attempt [id]` | List artifacts or inspect one artifact |
| `approve-attempt <id>` | Apply artifact files to the source tree after creating backups |
| `reject-attempt <id>` | Mark a pending artifact as rejected |
| `rollback-attempt <id>` | Restore files from an approved artifact backup |
| `report` | Show attempts, success rate, cost, cache, and strategy performance |
| `show-policy` | Show sampling probabilities by experience key |
| `show-genomes` | Show strategy genome pool |
| `show-mutations` | Show mutation history |
| `show-health` | Show experience-key health diagnostics |

## Architecture

```text
Goal / Work Capsule
        |
        v
ExperienceKey -----------------------------+
        |                                  |
        v                                  |
Strategy Sampler <--- Pheromones <--- Reward Engine
        |                                  ^
        v                                  |
Worker Attempt -> Verification -> Attempt + Patch Artifact
        |                                  |
        v                                  |
Mutation / Crossover / Tournament --------+
```

Core modules:

| Module | Responsibility |
|---|---|
| `src/cli.ts` | CLI entrypoint, experiment loop, reporting, artifact commands |
| `src/realWorker.ts` | Real attempt orchestration and shared reconnaissance |
| `src/runtime/` | Single pi-agent-core runtime scaffold and AntCode runtime contract |
| `src/tools/` | Universal tool definitions and local operations backend |
| `src/verify.ts` | Workbench slots, patch artifacts, approval, rejection, rollback |
| `src/reward.ts` | Reward calculation and failure-mode signal |
| `src/mutation.ts` / `src/mutationOps.ts` | Evidence-driven strategy mutation |
| `src/crossover.ts` | Strategy crossover between strong candidates |
| `src/tournament.ts` | Parent-child promotion/suppression decisions |
| `src/storage.ts` | JSON / JSONL storage primitives |

## Runtime state

AntCode stores evolution state in `.antcode/`:

```text
.antcode/
├── policy.json
├── strategy-genomes.jsonl
├── strategy-pheromones.jsonl
├── negative-pheromones.jsonl
├── attempts.jsonl
├── reward-bundles.jsonl
├── mutation-events.jsonl
├── experience-key-health.jsonl
└── artifacts/
```

Treat this as product data. It explains why a strategy was selected, how it performed, and whether it should be promoted, suppressed, or mutated.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `ANTCODE_RUNTIME` | `pi` | Agent runtime scaffold. AntCode intentionally keeps one clean runtime path on `pi-agent-core`. |
| `ANTCODE_LLM_BASE_URL` | `https://sub.foxnio.com/v1` | OpenAI-compatible API base URL |
| `ANTCODE_LLM_API_KEY` | — | Required for real LLM mode |
| `ANTCODE_LLM_MODEL` | `gpt-5.4` | Model used by real worker and task generation |
| `ANTCODE_MAX_WORKBENCHES` | `4` | Safety cap for simultaneously active workbench slots |
| `ANTCODE_AGENT_TIMEOUT_MS` | `45000` | Per-attempt pi agent timeout |
| `ANTCODE_TASKGEN_TIMEOUT_MS` | `30000` | Dynamic task generation timeout |
| `ANTCODE_CONCURRENCY` | `3` | Parallel real workers per batch |

No API key is required for mock evolution.

## Performance snapshot

Latest recorded benchmark from the v0.5 optimization line:

| Metric | Value |
|---|---:|
| Success rate | 91.7% — 11 / 12 attempts |
| Cache hit rate | 41.5% |
| Estimated cost / attempt | $0.24 |
| Average reward | 0.656 |
| Average diff size | 16 lines |
| Genome pool | 7 active / 4 candidate / 26 suppressed |

v0.8 focuses on runtime boundary cleanup and release hygiene rather than a new performance benchmark.

## Roadmap

- **v0.8.x** — harden pi runtime observability, artifact status transitions, and workspace configuration.
- **v0.9** — local service mode with HTTP API and background queue.
- **v1.0** — web console for runs, strategies, costs, patches, and failure modes.
- **v1.1** — safe repository maintenance product with policy packs, approval gates, and audit logs.

See [`docs/11_productization_roadmap.md`](docs/11_productization_roadmap.md).

## Release

- GitHub Release: <https://github.com/telagod/antcode/releases/tag/v0.8.0>
- Package artifact: [`antcode-0.8.0.tgz`](https://github.com/telagod/antcode/releases/download/v0.8.0/antcode-0.8.0.tgz)

## Security model

AntCode is intentionally conservative about self-modification:

1. Real runs can be forced into `--no-auto-merge`.
2. Patch artifacts must be reviewed before approval.
3. Approval creates backups.
4. Rollback restores from approval backups.
5. Secrets must come from environment variables, never from source.

## Repository layout

```text
antcode/
├── README.md
├── package.json
├── src/
├── tests/
├── docs/
├── schemas/
├── templates/
├── examples/
│   └── state/v0.7.0/      # seed .antcode state
├── scripts/
└── archives/              # historical versions
```

## Status

AntCode is an experimental productization track. It is ready for local experimentation and GitHub release distribution, but should still be run with review gates before being trusted on important repositories.

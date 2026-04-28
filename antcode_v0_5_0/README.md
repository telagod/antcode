# AntCode v0.7.0

**Safe self-evolving code agent for TypeScript repositories.**

AntCode samples strategy genomes, runs code-improvement agents, verifies their changes, scores the result, and evolves better strategies over time. v0.7.0 adds the first safe self-modification workflow: patch artifacts, review gates, approval, rejection, and rollback.

## Install

```bash
npm install
npm run typecheck
npm test
```

## Run

Mock evolution, no LLM required:

```bash
npm run demo
```

Real LLM mode:

```bash
export ANTCODE_LLM_BASE_URL="https://your-openai-compatible-endpoint/v1"
export ANTCODE_LLM_API_KEY="sk-..."
export ANTCODE_LLM_MODEL="gpt-5.4"

npm run demo:real
```

## Safe self-modification

Generate a patch artifact without auto-merging:

```bash
npx tsx src/cli.ts run-experiment 1 --real --no-auto-merge
```

Review pending artifacts:

```bash
npx tsx src/cli.ts review-attempt
npx tsx src/cli.ts review-attempt <attempt_id_or_artifact_id>
```

Approve, reject, or roll back:

```bash
npx tsx src/cli.ts approve-attempt <attempt_id_or_artifact_id>
npx tsx src/cli.ts reject-attempt <attempt_id_or_artifact_id>
npx tsx src/cli.ts rollback-attempt <attempt_id_or_artifact_id>
```

Artifacts are stored under:

```text
.antcode/artifacts/<artifact_id>/
├── manifest.json
├── patch.diff
├── files/
└── verification.log
```

## CLI

| Command | Purpose |
|---|---|
| `run-experiment [n] [--real] [--no-auto-merge]` | Run mock or real evolution attempts |
| `review-attempt [id]` | List artifacts or inspect one artifact |
| `approve-attempt <id>` | Apply artifact files after creating backups |
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
  -> ExperienceKey
  -> StrategyGenome sampler
  -> Worker attempt
  -> Verification + Patch Artifact
  -> RewardBundle
  -> Pheromone update
  -> Mutation / Crossover / Tournament
  -> Updated sampling policy
```

## Core modules

| Module | Responsibility |
|---|---|
| `src/cli.ts` | CLI, experiment loop, reports, artifact commands |
| `src/realWorker.ts` | Real LLM tool loop |
| `src/tools/` | Universal tools and local operations backend |
| `src/verify.ts` | Workbench, patch artifacts, approve/reject/rollback |
| `src/reward.ts` | Reward calculation |
| `src/mutation.ts` | Mutation decisions |
| `src/crossover.ts` | Strategy crossover |
| `src/tournament.ts` | Promotion and suppression |
| `src/storage.ts` | JSON / JSONL persistence |

## Scripts

| Script | Purpose |
|---|---|
| `npm run typecheck` | TypeScript validation |
| `npm test` | Smoke and regression tests |
| `npm run demo` | Mock experiment loop |
| `npm run demo:real` | Real LLM experiment loop |
| `npm run report` | Experiment summary |
| `npm run show:*` | Inspect policy, genomes, mutations, health |

## Runtime data

`.antcode/` stores strategy genomes, pheromones, attempts, rewards, mutation events, health diagnostics, and patch artifacts. Treat it as product state, not disposable logs.

## Release

- GitHub Release: <https://github.com/telagod/antcode/releases/tag/v0.7.0>
- Package artifact: <https://github.com/telagod/antcode/releases/download/v0.7.0/antcode-0.7.0.tgz>

## Security notes

- Real mode requires `ANTCODE_LLM_API_KEY`.
- Never commit API keys or provider tokens.
- Prefer `--no-auto-merge` for self-modification.
- Review artifacts before approval.
- Use rollback if an approved artifact needs to be undone.

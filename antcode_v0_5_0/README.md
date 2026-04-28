# AntCode v0.7.0 — Safe Self-Evolving Code Agent

AntCode is a TypeScript-based autonomous code improvement system. It samples strategy genomes, runs code agents with universal tools, verifies changes, scores attempts, and evolves the strategies that produce better outcomes.

This package is the current productization base. v0.7.0 adds the first safe self-modification release path: AntCode can generate patch artifacts, hold them for review, apply approved artifacts, reject bad artifacts, and roll back approved artifacts from backups.

## Current Capabilities

- Strategy genome sampling with positive and negative pheromones
- Mock and real LLM worker modes
- Universal tool loop: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `done`
- Reward calculation with semantic, cost, cache, and boundary signals
- Mutation and parent-child tournament mechanics
- Shared insight collection across attempts
- CLI reports for genomes, policy, mutations, health, and experiment summary

## Quick Start

```bash
npm install
npm run typecheck
npm test
npm run report
```

Run mock evolution:

```bash
npm run demo
```

Run real LLM mode:

```bash
export ANTCODE_LLM_BASE_URL="https://your-openai-compatible-endpoint/v1"
export ANTCODE_LLM_API_KEY="sk-..."
export ANTCODE_LLM_MODEL="gpt-5.4"
npm run demo:real
```

## CLI

```bash
npm run run-experiment -- 8
npx tsx src/cli.ts run-experiment 1 --real --no-auto-merge
npx tsx src/cli.ts review-attempt
npx tsx src/cli.ts review-attempt <attempt_id_or_artifact_id>
npx tsx src/cli.ts approve-attempt <attempt_id_or_artifact_id>
npx tsx src/cli.ts reject-attempt <attempt_id_or_artifact_id>
npx tsx src/cli.ts rollback-attempt <attempt_id_or_artifact_id>
npm run report
npm run show:policy
npm run show:genomes
npm run show:mutations
npm run show:health
```

## Productization Priorities

The next product direction is intentionally staged:

1. **Reliable CLI Core** — typecheck, tests, safe config, stable storage, deterministic reports.
2. **Project Workspace Runner** — isolate target repos, snapshot/rollback patches, define work capsules.
3. **Service API** — expose experiments, attempts, policies, and reports over HTTP.
4. **Web Console** — inspect runs, strategies, costs, patches, and promotion decisions.
5. **Team Controls** — approval gates, audit logs, policy packs, secrets hygiene, and budget limits.
6. **Plugin Backends** — local, Docker, SSH, and future remote execution adapters through `Operations`.

See `docs/11_productization_roadmap.md` for the v0.6+ roadmap.

## Architecture Map

```text
Goal / Work Capsule
  -> ExperienceKey
  -> StrategyGenome sampler
  -> Worker attempt (mock or real LLM tool loop)
  -> Verification and merge decision
  -> RewardBundle
  -> Pheromone update
  -> Mutation / crossover / tournament
  -> Policy and strategy pool updates
```

## Important Runtime State

`.antcode/` stores current evolution state:

- `strategy-genomes.jsonl`
- `strategy-pheromones.jsonl`
- `negative-pheromones.jsonl`
- `attempts.jsonl`
- `reward-bundles.jsonl`
- `mutation-events.jsonl`
- `experience-key-health.jsonl`
- `policy.json`
- `artifacts/<artifact_id>/` stores pending patch review artifacts

Treat this as product data, not disposable logs.

## Safe Self-Modification Path

The earliest safe mode for AntCode to modify itself is:

```bash
npx tsx src/cli.ts run-experiment 1 --real --no-auto-merge
npx tsx src/cli.ts review-attempt <attempt_id_or_artifact_id>
npx tsx src/cli.ts approve-attempt <attempt_id_or_artifact_id>
# if needed after approval:
npx tsx src/cli.ts rollback-attempt <attempt_id_or_artifact_id>
```

In this mode AntCode may create changes in an isolated workbench and emit a patch artifact, but it does not write the patch back to the source tree automatically. Approval creates a backup before applying files; rollback restores that backup.

## Scripts

| Script | Purpose |
|---|---|
| `npm run typecheck` | TypeScript validation |
| `npm test` | Current smoke/regression tests |
| `npm run demo` | Mock experiment loop |
| `npm run demo:real` | Real LLM experiment loop |
| `npm run report` | Summarize experiment state |
| `npm run show:*` | Inspect policy/genomes/mutations/health |

## Security Notes

- Real LLM mode requires `ANTCODE_LLM_API_KEY`; no API key should be committed.
- Target repository execution should move toward isolated workspaces before becoming a hosted product.
- Patches must remain reviewable and reversible.

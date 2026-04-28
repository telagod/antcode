# 11. Productization Roadmap

AntCode v0.8.1 hardens the clean pi-agent-core runtime boundary with observability, stricter timeout behavior, and productized artifact review while preserving the safe self-modification loop. The repository now follows a root-package layout: package metadata, source, tests, docs, schemas, templates, scripts, and examples live at the repository root. Productization means turning that loop into a reliable developer product with clear boundaries, observability, safety controls, and repeatable operations.

## Product Thesis

AntCode should become a self-improving code maintenance agent that can run safely on a repository, discover small improvements, verify them, and learn which strategies work for each class of task.

The product is not just “an LLM that edits files”. The defensible core is the learning loop:

```text
strategy -> attempt -> verification -> reward -> pheromone -> mutation/tournament -> better strategy
```

## Target Users

1. **Solo developer / maintainer**
   - Wants automatic low-risk cleanup and type/test fixes.
   - Needs CLI-first workflow and patch review.

2. **Small engineering team**
   - Wants recurring maintenance runs on selected repos.
   - Needs budgets, approvals, audit trails, and dashboards.

3. **Platform / DevEx team**
   - Wants a policy-driven code improvement service.
   - Needs runner isolation, integrations, metrics, and pluggable backends.

## Product Layers

### 1. CLI Core

Scope:
- Deterministic commands
- Stable config loading
- Typecheck and smoke tests
- Safe secret handling
- Report and inspect commands

Exit criteria:
- `npm run typecheck` passes
- `npm test` passes
- CLI version matches package version
- Real mode fails fast when credentials are missing

### 2. Workspace Runner

Scope:
- Run attempts in isolated workspaces
- Capture baseline before mutation
- Produce patch artifacts
- Support rollback and clean retry
- Separate AntCode state from target repo state

Exit criteria:
- A failed attempt cannot corrupt the source workspace
- Every successful merge has a reproducible diff and verification log

### 3. Service API

Scope:
- REST API for runs, attempts, strategies, reports, and policies
- Background worker queue
- Persistent storage adapter
- Auth boundary for hosted/team use

Candidate resources:
- `Run`
- `Attempt`
- `StrategyGenome`
- `RewardBundle`
- `Policy`
- `PatchArtifact`

### 4. Web Console

Scope:
- Run timeline
- Strategy pool health
- Cost/cache metrics
- Patch review view
- Failure mode explorer
- Promotion/suppression explanations

### 5. Governance and Safety

Scope:
- Approval gates before merge
- Budget limits per run/repo/team
- Secret redaction in logs and prompts
- Policy packs for allowed files and commands
- Audit trail for every automated decision

### 6. Single pi Runtime Scaffold

Scope:
- Keep `realWorker` provider-agnostic
- Use `pi-agent-core` as the only agent-turn/tool-loop scaffold
- Let pi own provider compatibility, session affinity, hooks, tool validation, abort, and sequential execution
- Keep AntCode focused on evolution strategy, reward, artifacts, tournament, and workbench safety

Exit criteria:
- `ANTCODE_RUNTIME` is optional and only accepts `pi` aliases
- No native Responses/OpenAI SDK/AI SDK runtime forks remain in AntCode
- Runtime behavior is covered by a small contract test and delegated to pi for provider breadth

## v0.6.0 Milestone: Product Foundation

Goal: make AntCode a reliable CLI product base.

Deliverables:
- Passing typecheck and smoke tests
- Current README reflects v0.8.1 behavior
- Product roadmap documented
- No committed default LLM API key
- CLI report/help version corrected
- Test command available through `npm test`

Non-goals:
- Web UI
- Hosted service
- Multi-tenant auth
- Database migration

## v0.7.1 Milestone: Safe Workspace Execution

Goal: make attempts reversible and reproducible.

Deliverables:
- Workspace abstraction with source, workbench, and artifact paths
- Patch artifact generation
- Verification log capture
- Rollback command
- Workspace-level config file

### Current v0.7.1 Slice

Implemented first:

- `--no-auto-merge` for real runs
- `.antcode/artifacts/<artifact_id>/manifest.json`
- `.antcode/artifacts/<artifact_id>/patch.diff`
- `.antcode/artifacts/<artifact_id>/files/`
- `.antcode/artifacts/<artifact_id>/verification.log`
- `review-attempt [attempt_id|artifact_id]`

Still pending for the safety line:

- stronger artifact status transitions
- workspace config and retention policy

## v0.8.x Milestone: Runtime Boundary Cleanup

Goal: stop spending AntCode effort on non-core provider/tool-loop compatibility.

Deliverables:
- Single `pi-agent-core` runtime scaffold
- `@mariozechner/pi-ai` task generation
- Removed native Responses/OpenAI SDK/AI SDK runtime forks
- Workbench lifecycle cap and cleanup guard
- Runtime contract test
- Runtime observability summary for tool calls, assistant messages, blocked tools, elapsed time, and timeout status
- Harder abort path with timeout + abort grace window
- Productized artifact review output with status summary, patch preview, and suggested next command

## v0.9.0 Milestone: Local Service Mode

Goal: expose AntCode as a local daemon/API.

Deliverables:
- HTTP API for run creation and inspection
- Background queue
- Local persistent store adapter
- Structured event stream

## v0.9.0 Milestone: Product Console

Goal: make the evolution loop visible and reviewable.

Deliverables:
- Web UI run dashboard
- Strategy genome browser
- Patch review panel
- Cost and cache charts
- Failure-mode drilldown

## v1.0.0 Criteria

AntCode can be called a full product when:

- It runs on a target repo without corrupting source state.
- Every patch is reproducible, reviewable, and attributable.
- Users can configure goals, budgets, commands, and file boundaries.
- Strategy evolution improves measured outcomes over repeated runs.
- Safety controls are first-class, not bolted on after the fact.

# Version: AntCode v0.8.2

## 名称

**Safe Self-Evolving Code Agent with pi Runtime Scaffold**

## 版本定位

v0.8.2 是 AntCode 的 real run 稳定性加固版本：在 v0.8.1 可观测 runtime 基础上，将默认 real agent timeout 放宽到 90s，并补上空 strategy state 的 fail-fast 保护，避免 workbench churn。

```text
v0.5.0: LLM 自主探索 + tool loop + 多 agent 协作
v0.6.0: 产品化地基，typecheck/test/doc/version hygiene
v0.7.1: patch artifact + review gate + approve/reject/rollback
v0.8.0: single pi-agent-core runtime scaffold + workbench lifecycle guard
v0.8.1: pi runtime observability + hard timeout guard + artifact review UX
v0.8.2: 90s real-run timeout + empty genome fail-fast + workbench churn guard
```

## 核心问题

```text
AntCode 的核心价值是什么？

不是重复造 provider SDK、Responses normalization 或 tool-loop 胶水。
真正核心是：策略如何演化、尝试如何验证、成果如何评分、失败如何反馈、修改如何安全落地。
```

## v0.8.2 新增能力

### 1. Single pi Runtime Scaffold

真实 worker 统一通过 `pi-agent-core` 执行 Agent turn 和工具调用。

```text
realAttempt
  -> AgentRuntime.run(...)
  -> pi-agent-core
  -> local AntCode tools
  -> AgentRunResult
```

AntCode 保留一个很薄的 runtime contract：

```text
src/runtime/
├── cache.ts
├── factory.ts
├── index.ts
├── piModel.ts
├── piRuntime.ts
├── prompt.ts
└── types.ts
```

### 2. Runtime Boundary Cleanup

已移除实验性多 runtime 分叉：

- native Responses runtime
- official OpenAI SDK runtime
- Vercel AI SDK runtime
- AI SDK provider routing shim

`ANTCODE_RUNTIME` 现在是可选项，只接受 `pi` / `pi-agent` / `pi-agent-core` aliases。

### 3. pi-powered Task Generation

动态任务生成也改为走 `@mariozechner/pi-ai`，避免 task generation 和 real worker 使用两套 provider plumbing。

### 4. Workbench Lifecycle Guard

Workbench slot 收敛到 `.antcode/workbenches/slot_<id>`，并加入：

- `ANTCODE_MAX_WORKBENCHES`
- real attempt `finally` cleanup
- shared recon `finally` cleanup
- nested real AntCode run guard

这解决了 workbench 反复创建/删除失控的问题。


### 6. Runtime Observability

真实 pi runtime 会记录并汇总：

- tool start / end
- blocked tool calls
- assistant message count
- elapsed time
- timeout status

这些信息会进入 real run console output 和 attempt notes。

### 7. Hard Timeout / Abort Guard

`ANTCODE_AGENT_TIMEOUT_MS` 触发后会调用 `agent.abort()`；如果 `ANTCODE_AGENT_ABORT_GRACE_MS` 内仍不 settle，则该 run 明确失败，避免 real run 长时间挂住。

### 8. Productized Artifact Review

`review-attempt` 现在提供 artifact 状态总览、patch preview、changed files table 和 suggested commands，让人工审批更接近产品工作流。


### 9. Wider Real-run Timeout

18 轮本地 real run 显示 45s 对真实 read/edit/bash/done loop 偏紧。默认值调整为：

```text
ANTCODE_AGENT_TIMEOUT_MS=90000
```

保留 `ANTCODE_AGENT_ABORT_GRACE_MS=1500`，确保超时后仍能快速失败。

### 10. Empty Genome Fail-fast

如果 `.antcode/strategy-genomes.jsonl` 缺失或为空，run-experiment 会直接提示 `npm run init-state`，不会进入 workbench 创建循环。

### 5. Release Hygiene

- package version 升级到 `0.8.2`
- README / architecture / roadmap 同步 runtime 边界
- `.env.example` 提供无密钥配置模板
- `.env.local` / `.env.*` 默认忽略
- `npm run typecheck` 和 `npm test` 作为发布门禁

## 安全边界

v0.8.2 仍坚持：

```text
AntCode 生成 artifact → 小宝 review → approve → 必要时 rollback
```

更高自动化可以继续推进，但必须建立在 artifact 质量、rollback 可靠性、reward hacking guard 都稳定之后。

# Version: AntCode v0.8.1

## 名称

**Safe Self-Evolving Code Agent with pi Runtime Scaffold**

## 版本定位

v0.8.1 是 AntCode 的 pi runtime 产品化加固版本：在 v0.8.0 单 runtime 边界上，补齐 runtime observability、硬超时/abort guard，以及更适合人工审批的 artifact review 体验。

```text
v0.5.0: LLM 自主探索 + tool loop + 多 agent 协作
v0.6.0: 产品化地基，typecheck/test/doc/version hygiene
v0.7.1: patch artifact + review gate + approve/reject/rollback
v0.8.0: single pi-agent-core runtime scaffold + workbench lifecycle guard
v0.8.1: pi runtime observability + hard timeout guard + artifact review UX
```

## 核心问题

```text
AntCode 的核心价值是什么？

不是重复造 provider SDK、Responses normalization 或 tool-loop 胶水。
真正核心是：策略如何演化、尝试如何验证、成果如何评分、失败如何反馈、修改如何安全落地。
```

## v0.8.1 新增能力

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

### 5. Release Hygiene

- package version 升级到 `0.8.1`
- README / architecture / roadmap 同步 runtime 边界
- `.env.example` 提供无密钥配置模板
- `.env.local` / `.env.*` 默认忽略
- `npm run typecheck` 和 `npm test` 作为发布门禁

## 安全边界

v0.8.1 仍坚持：

```text
AntCode 生成 artifact → 小宝 review → approve → 必要时 rollback
```

更高自动化可以继续推进，但必须建立在 artifact 质量、rollback 可靠性、reward hacking guard 都稳定之后。

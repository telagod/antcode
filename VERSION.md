# Version: AntCode v0.7.1

## 名称

**Safe Self-Evolving Code Agent**

## 版本定位

v0.7.1 是 AntCode 从“能自主改代码”走向“能安全自改”的版本。

```text
v0.5.0: LLM 自主探索 + tool loop + 多 agent 协作
v0.6.0: 产品化地基，typecheck/test/doc/version hygiene
v0.7.1: patch artifact + review gate + approve/reject/rollback
```

## 核心问题

```text
AntCode 什么时候能自己接命令、自己改自己，而不需要外部 Codex 直接动手？

答案：当每次自改都能隔离生成、人工审阅、明确批准、可拒绝、可回滚。
```

## v0.7.1 新增能力

### 1. Safe Self-Modification Path

真实 LLM 模式可以通过 `--no-auto-merge` 只生成 patch artifact，不直接写回源码。

```bash
npx tsx src/cli.ts run-experiment 1 --real --no-auto-merge
npx tsx src/cli.ts review-attempt <attempt_id_or_artifact_id>
```

### 2. Patch Artifact

每次成功产生文件变更的 real attempt 会写入：

```text
.antcode/artifacts/<artifact_id>/manifest.json
.antcode/artifacts/<artifact_id>/patch.diff
.antcode/artifacts/<artifact_id>/files/
.antcode/artifacts/<artifact_id>/verification.log
```

### 3. Review / Approve / Reject / Rollback

```bash
npx tsx src/cli.ts review-attempt [attempt_id|artifact_id]
npx tsx src/cli.ts approve-attempt <attempt_id|artifact_id>
npx tsx src/cli.ts reject-attempt <attempt_id|artifact_id>
npx tsx src/cli.ts rollback-attempt <attempt_id|artifact_id>
```

- `approve-attempt`：将 artifact files 应用到项目源码，并先保存 backup。
- `reject-attempt`：将 pending artifact 标记为 rejected，不修改源码。
- `rollback-attempt`：仅对 merged artifact 生效，使用 backup 恢复审批前状态。

### 4. Release Hygiene

- package version 升级到 `0.7.1`。
- CLI help/report 文案同步到 v0.7.1。
- `npm run typecheck` 和 `npm test` 作为发布门禁。

## 安全边界

v0.7.1 仍不建议默认完全自动合并。推荐路径是：

```text
AntCode 生成 artifact → 小宝 review → approve → 必要时 rollback
```

只有在多轮 artifact 质量稳定、rollback 被验证可靠、策略没有 reward hacking 后，才考虑更高自动化。

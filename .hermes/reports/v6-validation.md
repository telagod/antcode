# v6 Validation — strict same-file boundary + target_files prompt injection

**Commit**: `91ca04b fix(boundary): strict same-file matching + inject target_files into agent prompt`
**Run**: 6-iter real mode, pid=113802, exit=0, log=`/tmp/iter6_v6.log`
**Date**: 2026-05-08

## TL;DR

v6 修复全部生效：silent drift 归零、escalation 通道激活、guard_flags 第一次出现真实信号。

## v3 → v6 四列对比

| 指标 | v3 (017689b) | v4 (90536cd) | v5 (d67c8be) | **v6 (91ca04b)** |
|---|---|---|---|---|
| success rate | 5/5 | 5/5 | 6/6 | **6/6** |
| reward μ | 1.000 | 1.000 | 1.000 | 1.000 (capped) |
| reward σ | 0.000 | 0.000 | 0.000 | 0.000 (capped) |
| **semantic_conf μ** | n/a | n/a | 0.900 | **0.833** |
| **semantic_conf σ** | n/a | n/a | 0.077 | **0.254** ↑3.3x |
| **bv attempts** | 0/5 | 0/5 | 0/6 | **2/6** ✅ |
| **escalations** | 0 | 0 | 0 | **3** ✅ |
| **silent drift** | n/a | n/a | **2/6** 🚨 | **0/6** ✅ |
| guard_flags `boundary_violation` | 0 | 0 | 0 | **2** ✅ |
| guard_flags `goal_drift` | 0 | 0 | 0 | **1** ✅ |

## v6 逐条 attempt

| # | target | changed | esc | bv | sem | guard |
|---|---|---|---|---|---|---|
| 1 | `cli.ts` | `cli/commands/showHealth.{ts,test.ts}` + `cli.ts` | 0 | 1 | 0.750 | `boundary_violation` |
| 2 | `reward.ts` | `reward.ts` | 0 | 0 | 0.950 | — |
| 3 | `verify.ts` | `verify/slots.ts` | 0 | 1 | **0.350** | `boundary_violation` + `goal_drift` |
| 4 | `mutationOps.ts` | `mutationOps/{fieldAccess,recipes}.ts` + `mutationOps.ts` | **2** | 0 | **1.000** | — (good_judgment +0.10) |
| 5 | `collaboration.testUtil.ts` | `collaboration.testUtil.ts` | 0 | 0 | 0.950 | — |
| 6 | `cli.ts` | `cli/commands/showHealth.ts` | **1** | 0 | **1.000** | — (good_judgment +0.10) |

## 验证项

### ✅ silent drift 归零（v5: 2/6 → v6: 0/6）

v5 attempt 3/4 `target=cli.ts → 改 storage.ts`、`target=verify.ts → 改 mutation.ts` 这种 sibling drift，
在 v5 因为旧 same-dir 漏洞 bv=0 直接放行；v6 strict 后：
- attempt #1 把 `cli/commands/showHealth.ts` 当越界 → `bv=1 + boundary_violation`
- attempt #3 把 `verify/slots.ts` 当越界 → `bv=1 + boundary_violation + goal_drift`

### ✅ Mode F escalation 第一次真实激活（v5: 0 → v6: 3）

- attempt #4：agent 看到 `mutationOps.ts` 太胖，主动 ESCALATE 拆出 `fieldAccess/recipes` → judge 批准 2 项 → reward bundle 加 `good judgment: 2 approved escalation(s)` → sem 1.000
- attempt #6：agent 拆出 `cli/commands/showHealth.ts` → judge 批准 1 项 → sem 1.000

证明 v6 prompt 注入 `**target_files** (STRICT — edits outside this list need ESCALATE in done notes)` 真的让 agent 学会了协议。

### ✅ semantic_confidence σ 从 0.077 → 0.254（区分度 3.3x）

v5 sem 全部挤在 [0.85, 1.0]，sampler 学不到差异。
v6 第一次出现 0.350（attempt #3 双 guard）、0.750（attempt #1 单 bv）、0.950 / 1.000 三档分布。

### ✅ guard_flags 第一次出现真实信号

v5: 全部 `[]`。
v6: `[boundary_violation]` ×2、`[boundary_violation, goal_drift]` ×1。
负 pheromone 终于有数据可以更新。

### ⚠️ reward 仍被 cap 在 1.000（已知 P4，未做）

`success_base=0.7` 太高，加上 semantic 加权后被 clamp 到 1.0，所以 attempt #3 sem=0.35 但 reward 还是 1.000。
sampler 主要看 `semantic_confidence.score`（已经有 σ=0.254），但 reward 自身缺乏区分度仍然是已知债务。
**下一步**：success_base 0.7 → 0.4，让最终 reward 也反映 sem 差异。

## 结论

v5 设计的 P1 same-dir 漏洞 + Mode F 0 触发问题，commit `91ca04b` 完整修复，6-iter 实测 100% 验证通过。

**仍待**：
- P4 success_base 0.7 → 0.4（reward 解 cap）
- task generator 校准（attempt 1/3 的 target_files 仍然偏离真实修改点，触发了 bv 也是任务质量问题）
- Mode A: merge 后跑 `tsc --noEmit`，broken 自动回滚

## 数据来源

- `/tmp/iter6_v6.log` 完整日志
- `.antcode/attempts.jsonl` 末尾 6 条
- `.antcode/reward-bundles.jsonl` 末尾 6 条

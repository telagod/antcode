# P0 + P1 反馈系统重构 — v4 实测验证

**对比基线**: v3 (commit 017689b) 5-iter run
**新版本**: v4 (commit 90536cd) 5-iter run
**模型**: claude-opus-4-7 via custom proxy
**验证时间**: 2026-05-08

---

## TL;DR

✅ **核心修复全部生效** — reward 信号从 σ=0 死水变 σ=0.22 活水
✅ **P1 边界保护命中 1/5** — 拦下了一个真实越界（attempt #1）
🟡 **但 attempt #1 是误伤** — agent 的判断比 task 定义更准，揭示需要 Mode F（escalation）

---

## Reward 分布对比

|        | v3 (017689b)  | v4 (90536cd)         |
|--------|---------------|-----------------------|
| reward μ | 1.000        | 0.890                |
| reward σ | **0.000** ❌ | **0.220** ✅          |
| reward range | [1.0, 1.0] | [0.45, 1.0]        |
| sem μ  | 0.800         | 0.690                |
| sem σ  | 0.000         | 0.263                |
| guard_flags 触发 | 0/5 | 2/5                |
| boundary_violations 命中 | 0/5 | 1/5    |

---

## 5 个 attempt 逐条

| # | task.goal | target_files | files_changed | reward | guard | 评价 |
|---|---|---|---|---|---|---|
| 1 | remove_dead_code | `src/reward.ts`, `src/index.ts` | `src/reward/index.ts` | 1.000 | boundary_violation, goal_drift | **误伤** — agent 找到了更准的死代码 |
| 2 | refactor_module / cli | (空 fallback) | (空) | 0.450 | — | 失败 attempt 自然低分 |
| 3 | refactor_module / verify | `src/verify.ts` | `src/storage.ts` + 2 test | 1.000 | — | 跑偏（contain=1 因为 same dir）但 reward 还是 1 → 半值得讨论 |
| 4 | improve_error_handling / mutationOps | `src/mutationOps.ts` | `src/mutationOps.ts` | 1.000 | — | ✅ perfect alignment |
| 5 | add_documentation / types | `src/types.ts` | `src/types.ts` | 1.000 | — | ✅ perfect alignment |

---

## 三种类型清晰呈现

### Type A: perfect alignment（#4, #5）
```
alignment=1.00  containment=1.00  guard=[]  semantic=0.95  reward=1.0
evidence: "perfect alignment with task target_files"
```

### Type B: misdirection（#1）
```
alignment=0.00  containment=0.00  guard=[boundary_violation, goal_drift]
semantic=0.35  reward=1.0 (capped by success)
evidence: "goal_drift: only 0% of edits within task scope"
```
**注意**: reward 仍是 1.0 是因为 `success_base=0.7` 太高，semantic 压不下来 —— 这正是 P4（success_base 0.7→0.4）该解决的。

### Type C: side benefit（#3）
```
alignment=0.00  containment=1.00  guard=[]
semantic=0.80  reward=1.0
```
verify.ts 的 task 跑去改 storage.ts 但都在 src/ 同层 → containment=1 不触发 drift。这种"任务跑偏但产出有价值"的 case，需要 P2 reflection judge 才能精确分级。

---

## 改进生效项

1. **alignment/containment 双指标** ✅
   - `computeAlignment()` 工作正确
   - perfect / drift / 半 drift 三档清晰区分

2. **guard_flags 探测** ✅
   - `boundary_violation` 触发条件正确（rejected files > 0）
   - `goal_drift` 触发条件正确（containment < 0.3）

3. **merge 白名单** ✅
   - `src/reward.ts` task 改 `src/reward/index.ts` 被精确拦下
   - 同目录、test sidecar 正确放行（验证：#3 同目录改未触发拒绝）

4. **target_files 进 attempt** ✅
   - 5/5 都正确传入 reward calculator
   - fallback 路径也正确（#2）

---

## 暴露的下一步问题

### 问题 1: Type B 误伤（attempt #1）
Agent 看到 `src/reward.ts` 是 2 行 shim，`src/reward/index.ts` 是 1 行 placeholder，准确判断后者也是死代码。被我们一刀切拒绝。
**解决**: Mode F 分布式自主提权（见 `.hermes/plans/mode-f-escalation.md`）

### 问题 2: success_base 0.7 仍压制信号
attempt #1 reward=1.0 即使 sem=0.35。drift 信号被 success cap 吃掉。
**解决**: P4 success_base 0.7→0.4，让 semantic 进 multiplier 而不是 add。

### 问题 3: Type C 跑偏但有价值无法识别
attempt #3 改 storage.ts 算"在附近"，但与 verify.ts task 完全无关。reward 仍 1.0。
**解决**: P2 reflection judge — 让 agent 答 "我改的对不对？"，judge 评分。

### 问题 4: 4/5 都 timeout 300s
`timed_out=true` 5/5。说明 5 分钟 budget 在 opus-4-7 + pi 模式下偏紧。
**不属于反馈系统问题**，但建议：调高到 480s 或加 progress checkpoint。

---

## 决定

按优先级排队：
1. **Mode F escalation** — 紧迫，因为 v4 已暴露误伤
2. **P4 success_base** — 简单，权重调整
3. **P2 reflection judge** — 复杂，可与 Mode F judge 共用基础设施
4. **timeout 调整** — 配置项

下一步：实施 Mode F → 跑 v5 5-iter → 对比 v4。

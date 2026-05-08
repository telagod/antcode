# antcode 反馈系统重设计 — P0+P1 落地

## 问题
5-iter v3 全部 reward=1.0、semantic_confidence=0.8 → 反馈瞎了，sampler 学不到东西。
两次任务跑偏（拆 cli.ts → 改 crossover/storage）但被 grader 当 success [MERGED]。

## 修复目标
让 reward 区分：
- 任务对口 + 改对（高分 ~0.95）
- 跑偏但顺手修对了别的问题（中分 ~0.55）
- 跑偏且没改对（低分 ~0.3）

并在 merge 前拒绝越界文件，根治 merge-cascade trap (Mode B)。

## 实施清单

### P0 — alignment 进 reward
1. `src/types.ts` Attempt 加 `target_files: string[]` + `task_id?: string`
2. `src/realWorker.ts:160` Attempt 构建拷贝 `task?.target_files ?? []`
3. `src/cli.ts:411` fallback Attempt 同步加
4. `src/reward/weights.ts` 加 `alignment_bonus`, `drift_penalty`, `drift_threshold`
5. `src/reward/calculator.ts`：
   - 计算 `alignment = filesInTarget / totalChanged`
   - 计算 `containment = filesInAllowed / totalChanged`（target_files + 同目录）
   - `containment < drift_threshold` → `guard_flags.push('goal_drift')` + `semantic -= drift_penalty`
   - `alignment >= 0.99` → `semantic += alignment_bonus`
   - evidence 列里写 `alignment=X.XX containment=Y.YY`

### P1 — merge 前白名单校验
1. `src/cli.ts:427` 调 `mergeFilesToProject` 之前先 filter：
   - 只允许 `task.target_files` 或同目录文件
   - test 配套（`*.test.ts`/`*.testUtil.ts`/`tests/...`）总是允许
2. 违规文件 → `attempt.boundary_violations.push(file)` + `notes.push("merge rejected out-of-scope: <f>")`
3. 仅把白名单内的写入主 worktree
4. 如果**全部**文件都越界 → 不调 mergeFilesToProject（变 success 但不 [MERGED]）

### 验证
1. `npx tsc --noEmit`（项目自身 tsc，忽略 node_modules 的 TS18028/TS2589）
2. 单元测试：
   - `src/reward/calculator.test.ts` — 跑偏任务 reward < 0.6，对口 > 0.85
3. 重跑 5-iter v4，对比 reward 分布方差
4. 故意安排一个 refactor 任务跑偏看 boundary 拦截

### Commit message
```
feat(reward): add alignment scoring and merge boundary enforcement

- Attempt now carries target_files; reward calculator computes
  alignment + containment vs. task scope.
- containment < 0.3 → goal_drift guard flag + semantic -0.4
- alignment === 1.0 → +0.15 semantic bonus
- mergeFilesToProject called with filtered set only; out-of-scope
  files trigger boundary_violations and never hit main worktree.
- Closes merge-cascade Mode B (agent edits piModel.ts during a
  sampler.ts task and silently merges).
```

## Out of scope（后续 plan）
- P2 reflection (LLM-as-judge)
- P3 genome compatibility
- P4 weight rebalance
- merge 后 typecheck (Mode A)

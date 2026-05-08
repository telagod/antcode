# antcode 反馈系统重设计 — 验证报告

**Commit**: `90536cd feat(reward): add task-alignment scoring and merge boundary enforcement`
**Date**: 2026-05-08

## 改动要点

### P0 — alignment 进 reward
| | |
|---|---|
| 数据流 | `RealTask.target_files` → `Attempt.target_files` → `RewardBundle.semantic_confidence` |
| 算法 | `alignment = |files ∩ target| / |files|`<br>`containment = |files ∩ (target ∪ same-dir ∪ test-sidecar)| / |files|` |
| 信号 | `containment < 0.3` → `goal_drift` flag + `semantic -= 0.4`<br>`alignment ≥ 0.99` → `semantic += 0.15`<br>`alignment ≥ 0.5` → `semantic += 0.075` |

### P1 — merge 前白名单
- `mergeFilesToProject` 之前对每个文件检查：在 `target_files` 内 / 同目录 / test sidecar
- 越界文件进 `boundary_violations` + notes，**不写入主 worktree**
- 全部越界 → `merge skipped: all N files out of scope`

## 单元验证 (commit 时已通过)

13/13 spike check 通过：

| Case | files_changed | target_files | reward | semantic | guard_flags |
|---|---|---|---|---|---|
| A 完全对口 | `src/foo.ts` | `src/foo.ts` | **0.857** | 0.950 | (none) |
| B 完全跑偏 | `src/runtime/piModel.ts` | `src/sampler.ts` | **0.520** | 0.400 | `goal_drift` |
| C legacy 无 target | `src/whatever.ts` | `[]` | 0.820 | 0.800 | (none) |
| D 半跑偏 | `[sampler.ts, piModel.ts]` | `[sampler.ts]` | **0.789** | 0.875 | (none) |

**关键效果**：B 这种"sampler 任务改 piModel"在旧 reward 下也是 1.0（等同 A），现在 0.52，sampler 学得到。

## 5-iter 实地验证 (run v4)

> Pending — `nohup ... run-experiment 5 --real > /tmp/iter5_v4.log` 进行中

填这一节需要：
1. ⏳ Reward 分布对比 (v3 全 1.0 / 0.8 → v4 应有方差)
2. ⏳ goal_drift 出现次数（之前 sampler→piModel 这种 case 至少 1 次出现过）
3. ⏳ boundary_violations 是否被正确填充
4. ⏳ 主 worktree `git status` — 应该只看到本次任务的 target_files 类文件

## 预期对比

| 指标 | v3 (commit 017689b) | v4 (commit 90536cd) 预期 |
|---|---|---|
| Success rate | 5/5 = 100% | 仍 100%（核心 4-Lever 没动） |
| Reward μ | 1.000 | 0.7-0.9（视 alignment 分布） |
| Reward σ | 0.0 | > 0.1（区分度回来） |
| `goal_drift` 出现 | 不存在 | 视任务/genome 配对，估 0-2 次 |
| 主 worktree 越界 | attempt#5 改 piModel.ts MERGED | 越界文件被拦在 merge 外 |

## Follow-up（已在 plan）

- **P2**: reflection step（agent done 前自答 SCOPE/INTENT 两题，LLM-as-judge 打分）
- **P3**: genome 加 `compatible_goal_patterns` 字段（学习式）
- **P4**: `success_base_success` 0.7→0.4 + alignment 进 multiplier，让 reward 区分度更大
- **Mode A 修复**: merge 后 tsc → 失败 git checkout 回滚（防止 broken merge 阻塞下次 run）

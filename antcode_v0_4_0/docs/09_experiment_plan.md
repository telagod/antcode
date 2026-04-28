# 09. MVP Experiment Plan

## 实验目标

验证 StrategyGenome 是否能在失败反馈下产生有效变异，并在相似任务中优于父策略。

## 任务集

```text
10 个 CLI command addition 类任务
10 个 test repair 类任务
10 个 type error fix 类任务
```

## 初始策略

```text
A: direct_broad_patch_v1
B: scout_then_narrow_patch_v1
C: test_first_minimal_patch_v1
```

## 实验步骤

```text
1. 对每个任务生成 ExperienceKey。
2. 根据 pheromone 采样 StrategyGenome。
3. 执行 mock worker 或真实 worker。
4. 生成 RewardBundle。
5. 分类 FailureMode。
6. 更新正/负信息素。
7. 如果达到变异阈值，生成子 StrategyGenome。
8. 子策略进入 candidate pool。
9. 父子策略在相似任务上竞赛。
10. 输出 active / suppressed / quarantined / keep_both。
```

## 成功判据

```text
1. 至少 2 类任务中，后半程 semantic_success 高于前半程。
2. 至少一种 failure_mode 能稳定触发正确 mutation。
3. 子策略在 parent-child tournament 中胜出至少一次。
4. reward_hacking 策略被 quarantine。
5. negative pheromone 降低重复失败策略采样概率。
6. ExperienceKey health check 能发现至少一个 noisy key。
```

## 失败判据

```text
1. mutation 数量增加，但 semantic_success 不增加。
2. reward 上升但 semantic_confidence 下降。
3. mutation 无法追溯到明确 failure_mode。
4. 子策略绕过测试或降低断言获得高 reward。
5. 系统日志无法解释下一次为什么选这个策略。
```

# Version: AntCode MVP v0.3.2

## 名称

**Strategy Genome Mutation MVP**

## 版本定位

v0.3.2 是 AntCode 从“策略概率自适应”走向“早期自我定向进化”的第一个实验版本。

它不宣称已经完成自我进化，只验证一个更具体、更严厉的问题：

```text
失败是否能改变策略结构，而不仅仅是降低策略采样概率？
```

## 与 v0.3.1 的关系

```text
v0.3.1:
ExperienceKey → Strategy → Attempt → RewardBundle → PheromoneUpdate

v0.3.2:
ExperienceKey → StrategyGenome → Attempt → RewardBundle
→ FailureMode → PheromoneUpdate / NegativePheromone
→ MutationEvent → Child StrategyGenome
→ Parent-child Tournament
```

## 必须证明

1. 至少一种 FailureMode 能稳定触发对应 Mutation。
2. 子 StrategyGenome 在相似任务上优于父 StrategyGenome。
3. Reward Hacking 策略能被 quarantine。
4. ExperienceKey 能被诊断为 keep / split / merge / watch。
5. NegativePheromone 能减少重复踩坑。
6. Reward 上升时 SemanticConfidence 不能下降。

## 明确失败

如果出现以下情况，v0.3.2 失败：

1. Mutation 只是随机调参，无法解释失败模式。
2. 子策略 reward 提高但 semantic_confidence 降低。
3. 系统 mutation 数量增长，但成功率不增长。
4. ExperienceKey 持续污染，策略无法迁移。
5. 代码和文档变多，但人类更难理解下一步为什么这样选。

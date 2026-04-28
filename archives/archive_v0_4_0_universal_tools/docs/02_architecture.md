# 02. Architecture

## 核心闭环

```text
Goal / Work Capsule
    ↓
ExperienceKey
    ↓
PolicySampler samples StrategyGenome
    ↓
Worker runs Attempt
    ↓
RewardEngine creates RewardBundle
    ↓
FailureModeClassifier labels failure
    ↓
PheromoneEngine updates positive / negative pheromone
    ↓
MutationEngine maybe creates Child StrategyGenome
    ↓
Tournament compares parent vs child
    ↓
Policy changes next sampling distribution
```

## 三类反馈

### 1. 正信息素

强化成功策略。

```text
高 semantic_success + 低 cost + 低 boundary_violation → 提高采样概率
```

### 2. 负信息素

抑制重复失败策略。

```text
反复 missing_test / high_diff_cost / boundary_violation → 降低采样概率
```

### 3. 策略变异

改变策略结构，而不只是改变概率。

```text
missing_test → validation_strategy 前移测试
context_underread → context_strategy 扩读上下文
boundary_blocked → boundary_strategy 一跳扩展
high_diff_cost → action_strategy 缩小 patch 粒度
reward_hacking → quarantine / reward profile 收紧
```

## 文件先行

所有状态都保存在 `.antcode/` 下的 JSON/JSONL 文件中：

```text
.antcode/
  policy.json
  strategy-genomes.jsonl
  strategy-pheromones.jsonl
  attempts.jsonl
  reward-bundles.jsonl
  mutation-events.jsonl
  negative-pheromones.jsonl
  experience-key-health.jsonl
```

不上数据库，避免过早平台化。

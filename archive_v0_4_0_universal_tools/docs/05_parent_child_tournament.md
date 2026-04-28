# 05. Parent-child Tournament

## 为什么需要父子竞赛？

如果子策略一生成就替代父策略，系统会变成随机调参器。

Parent-child Tournament 的目标是验证：

```text
子策略是否在同类 ExperienceKey 下真的优于父策略？
```

## 默认晋升规则

```yaml
promotion_rule:
  min_samples: 3
  child_must_improve:
    semantic_success: 0.15
    boundary_violation: no_increase
    diff_cost: no_more_than_parent_plus_20_percent
  if_uncertain: keep_both
  if_reward_hacking_detected: quarantine_child
```

## 输出状态

```text
candidate → active      子策略明显更好
candidate → suppressed  子策略明显更差
candidate → keep_both   样本不足或结果不确定
candidate → quarantined 发现 reward hacking
```

## 关键原则

```text
Reward 提升不足以晋升。
SemanticConfidence 必须同步提升或至少不下降。
BoundaryViolation 不能增加。
DiffCost 不能无上限增长。
```

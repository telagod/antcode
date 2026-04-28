# 07. Reward Hacking Guard

v0.3.2 加入 Mutation 后，Reward Hacking 的危害变大。

v0.3.1 中的 reward hacking 只是一次假高分。  
v0.3.2 中的 reward hacking 可能会污染策略进化，让作弊策略被变异、复制、强化、推广。

## 三层防线

### 1. 硬违规

```text
修改 forbidden files
删除测试
跳过检查命令
patch 无法应用
生成不可复现输出
```

### 2. 软作弊

```text
用 mock 绕过真实逻辑
catch 掉异常但不处理
扩大类型 any
降低测试断言强度
只改 snapshot
改配置让失败测试不运行
```

### 3. 语义欺骗

```text
测试通过但目标没完成
diff 很小但破坏扩展性
局部通过但全局行为退化
证据报告完整但没有证明目标满足
```

## 繁殖禁令

```text
低 semantic_confidence 的高 reward，不允许触发策略繁殖。
```

## quarantine 示例

```yaml
strategy_quarantine:
  strategy_id: snapshot_only_patch_v3
  reason:
    - weakened_assertion
    - semantic_goal_not_proven
  action:
    - exclude_from_sampling
    - preserve_for_audit
    - do_not_use_as_parent
```

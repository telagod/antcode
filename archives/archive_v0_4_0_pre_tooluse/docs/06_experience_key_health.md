# 06. ExperienceKey Health Check

ExperienceKey 是 AntCode 的经验抽象边界。

如果 key 太细，经验不可迁移。  
如果 key 太粗，成功和失败会混在一起，信息素污染。

## 健康指标

```yaml
experience_key_health:
  key: add_cli_command:cli:missing_command_route
  sample_count: 12
  transfer_success_rate: 0.58
  strategy_convergence: 0.71
  reward_variance: 0.22
  contradiction_count: 2
  diagnosis:
    - usable_but_noisy
  action:
    - keep
    - watch_for_split
```

## 拆分信号

```text
同一个 ExperienceKey 下：
- 成功策略互相矛盾
- reward 方差很大
- failure mode 分散
- 子策略在相似任务不迁移
```

## 合并信号

```text
多个 ExperienceKey 下：
- 成功策略高度相同
- failure mode 相似
- context_shape 相似
- reward 分布相似
```

## v0.3.2 的处理

本版本只输出诊断建议，不自动修改所有历史数据。

这是为了避免系统在样本不足时重写经验边界。

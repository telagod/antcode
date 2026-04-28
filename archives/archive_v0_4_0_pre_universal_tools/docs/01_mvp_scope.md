# 01. MVP Scope

## 必须有

```text
1. ExperienceKey
2. StrategyGenome
3. Attempt
4. RewardBundle
5. FailureMode
6. MutationEvent
7. StrategyPheromone
8. NegativePheromone
9. Parent-child Tournament
10. ExperienceKey Health Check
```

## 可选但本包提供草案

```text
1. JSON Schema
2. Codex Work Capsule Template
3. Worker Output Template
4. Observer CLI 输出示例
5. Mermaid 流程图
```

## 不做

```text
Web UI
数据库
复杂权限系统
多 agent 调度器
插件系统
向量库
AST 索引
完整代码仓库接入
真实 Codex API Adapter
```

## 为什么 mock worker 足够？

v0.3.2 的实验目标不是验证某个真实 worker 写代码能力，而是验证：

```text
失败分类 → 策略变异 → 父子竞争 → 策略采样改变
```

如果这个机制在 mock worker 下都无法成立，接真实 Codex 只会把问题掩盖在复杂执行里。

## 最小 CLI

```bash
antcode run-experiment
antcode show-policy
antcode show-genomes
antcode show-attempts
antcode show-mutations
```

本包的 TypeScript 草案已包含这些命令入口。

# AntCode MVP v0.3.2 — Strategy Genome + Mutation

> v0.3.1 验证：信息素是否改变下一次策略采样概率。  
> v0.3.2 验证：失败是否改变策略本身的结构。

AntCode v0.3.2 是一个**极端收缩的机制实验包**。它不追求完整 code-agent 平台，不做 Web UI、不接数据库、不做多 worker 调度、不做复杂插件。它只验证一条更接近“自我定向进化”的闭环：

```text
ExperienceKey
→ sample StrategyGenome
→ run Attempt / mock worker
→ calculate RewardBundle
→ classify FailureMode
→ update Pheromone / NegativePheromone
→ maybe mutate StrategyGenome
→ parent-child tournament
→ promote / suppress / quarantine
```

## 核心问题

```text
v0.3.1:
一次尝试的结果，是否改变了下一次策略采样概率？

v0.3.2:
一次失败，是否改变了策略结构？
```

## 本包包含

```text
antcode_mvp_v0_3_2/
  README.md
  VERSION.md
  package.json
  tsconfig.json
  docs/
    00_version_positioning.md
    01_mvp_scope.md
    02_architecture.md
    03_strategy_genome_and_mutation.md
    04_failure_modes.md
    05_parent_child_tournament.md
    06_experience_key_health.md
    07_reward_hacking_guard.md
    08_codex_boundary_protocol.md
    09_experiment_plan.md
    10_observer_cli.md
    flow.mmd
    flow.svg
  src/
    types.ts
    storage.ts
    sampler.ts
    reward.ts
    failureMode.ts
    mutation.ts
    tournament.ts
    health.ts
    simulator.ts
    cli.ts
    index.ts
  schemas/
    *.schema.json
  templates/
    *.template.yaml
  examples/
    tasks/*.yaml
    reports/*.txt
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

## 快速试跑

安装依赖后：

```bash
npm install
npm run demo
npm run show:genomes
npm run show:mutations
npm run show:policy
```

也可以只阅读 `docs/` 与 `.antcode/` 样例数据。本 MVP 的第一目标是设计清晰和机制可验证，而不是功能完备。

## 版本铁律

```text
任何不能改变 StrategyGenome 的功能，都不进入 v0.3.2。
任何 reward 提升但 semantic_confidence 降低的策略，不允许繁殖。
任何低语义证据的高 reward 策略，必须进入 quarantine。
任何无法解释触发原因的 mutation，都不算 mutation。
```

## 关键新增对象

### StrategyGenome

策略从“配置项”升级为“可变异对象”。它包含：

- context_strategy：读什么、读多少、读的顺序
- action_strategy：patch 粒度、是否优先沿用既有模式、是否允许架构变化
- validation_strategy：测试和验证顺序
- boundary_strategy：允许文件范围、最大 diff、边界扩展规则
- reward_profile：优化目标和惩罚项
- mutation_policy：失败模式到变异操作的映射

### MutationEvent

记录一次策略变异的原因、父策略、子策略、失败证据、假设和状态。

### NegativePheromone

不仅强化成功，也沉积“不要再这样做”的失败经验。负信息素必须可挥发，避免系统永久保守。

### Parent-child Tournament

子策略不能直接替代父策略，必须在同类 ExperienceKey 下与父策略比较：

- semantic_success 是否提高
- boundary_violation 是否没有增加
- diff_cost 是否没有暴涨
- reward 是否稳定提高
- reward hacking 是否没有出现

## 非目标

v0.3.2 明确不做：

```text
Web God View
数据库
多 worker 并发
复杂插件系统
完整蓝图编辑器
向量库
长期项目管理平台
```

这些能力只有在策略基因变异闭环被证明有效后，才值得工程化。

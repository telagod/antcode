# 03. StrategyGenome and MutationEvent

## StrategyGenome

StrategyGenome 是可变异策略体，不是普通配置。

```yaml
strategy_genome:
  id: scout_then_narrow_patch_v1
  parent_id: null
  status: active

  applies_to:
    goal_pattern: add_cli_command
    module_region: cli
    risk_level: low_to_medium

  context_strategy:
    read_order:
      - command_router
      - existing_command_examples
      - cli_tests
    max_files: 8
    scout_first: true

  action_strategy:
    patch_granularity: small
    prefer_existing_pattern: true
    forbid_architecture_change: true

  validation_strategy:
    required:
      - targeted_test
      - typecheck
    optional:
      - lint

  boundary_strategy:
    allowed_file_policy: affected_module_plus_tests
    max_diff_lines: 180

  reward_profile:
    optimize_for:
      - semantic_success
      - low_diff_cost
      - low_boundary_violation
    punish:
      - weakened_tests
      - broad_unnecessary_changes
      - hidden_config_bypass
```

## MutationEvent

MutationEvent 记录一次策略结构变化。

```yaml
mutation_event:
  id: mut_042
  parent_strategy: scout_then_narrow_patch_v1
  child_strategy: scout_then_test_first_v2

  triggered_by:
    experience_key: add_cli_command:cli:missing_command_route
    failure_mode: missing_test
    attempts:
      - attempt_017
      - attempt_023

  mutation:
    type: validation_order_change
    changed:
      validation_strategy.required:
        from:
          - targeted_test
          - typecheck
        to:
          - write_or_update_targeted_test
          - run_targeted_test
          - typecheck

  hypothesis:
    CLI command addition failures often come from patching before locking expected CLI behavior.

  status: candidate
```

## 变异原则

```text
1. 变异必须由 FailureMode 触发。
2. 变异必须有 parent_id。
3. 变异必须生成 hypothesis。
4. 子策略必须先 candidate，不能直接 active。
5. reward hacking 策略不能作为 parent。
6. low semantic_confidence 的高 reward 不能触发繁殖。
```

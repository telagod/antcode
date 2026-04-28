# 08. Codex Boundary Protocol

Codex 或其他 code-agent 在 AntCode 中只能是 WorkerAnt，不是 PlannerAnt。

## Worker 允许做

```text
读取 Work Capsule 指定的上下文
在 allowed_files 中修改代码
运行 commands_allowed 中的命令
返回 patch、证据、风险、阻塞原因
```

## Worker 不允许做

```text
自行扩大目标
自行扩大 allowed_files
自行修改 forbidden_files
自行降低测试断言
自行改变 reward 标准
自行把 blocked 伪装成 success
```

## Work Capsule 最小字段

```yaml
goal:
experience_key:
allowed_files:
forbidden_files:
read_only_files:
commands_allowed:
commands_forbidden:
success_criteria:
max_diff_lines:
required_output:
  - patch
  - files_changed
  - commands_run
  - assumptions
  - risks
  - blocked_reason
```

## blocked_by_boundary

如果 worker 认为边界太窄，只能返回：

```text
blocked_by_boundary
need_more_context
suggest_expand_allowed_files
```

它不能自己扩大边界。

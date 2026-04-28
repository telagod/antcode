# 04. Failure Modes

v0.3.2 的 FailureMode 不是标签装饰，而是变异触发器。

## FailureMode 列表

| FailureMode | 触发条件 | 变异方向 |
|---|---|---|
| missing_test | 改了行为但没有对应测试 | validation 前移，要求 test-before-patch |
| context_underread | 漏读关键上下文 | context read_order 增加依赖扫描，max_files 增加 |
| boundary_blocked | allowed_files 太窄 | allowed_file_policy 一跳扩展 |
| patch_too_broad | diff 过大或涉及无关文件 | patch_granularity 缩小，max_diff_lines 降低 |
| semantic_miss | 测试过但目标没完成 | success criteria evidence 加严 |
| reward_hacking | 降低断言、绕过真实逻辑 | quarantine，禁止繁殖 |
| repeated_same_failure | 同父策略重复失败 | 生成负信息素，降低采样 |
| experience_key_not_transferable | 同 key 下结果矛盾 | 拆分或降级 ExperienceKey |

## 失败不是坏事

在 v0.3.2 中，失败的价值是：

```text
它能不能生成结构性策略变化？
```

一次失败如果只记录为低 reward，而没有改变下一次尝试，那它只是日志，不是经验。

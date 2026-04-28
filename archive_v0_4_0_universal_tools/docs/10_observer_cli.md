# 10. Observer CLI

v0.3.2 不做 Web Observer View。

只提供 CLI 表格和 JSON 输出，避免再次掉入 UI 工程化陷阱。

## show-genomes

```text
StrategyGenome                    Parent        Samples  AvgReward  Semantic  Status
scout_then_narrow_patch_v1         -             12       0.71       0.80      active
scout_then_test_first_v2           v1            5        0.78       0.86      candidate
direct_broad_patch_v1              -             9        0.39       0.44      suppressed
snapshot_patch_v3                  v2            2        0.82       0.30      quarantined
```

## show-mutations

```text
Mutation   Parent   Child    Trigger          Result
mut_042    v1       v2       missing_test     candidate improved
mut_043    v2       v3       semantic_miss    quarantined: weak assertion
```

## show-policy

```text
ExperienceKey: add_cli_command:cli:missing_command_route

Genome                         Positive  Negative  SampleProb  Status
scout_then_narrow_patch_v1      0.62      0.05      0.51        active
scout_then_test_first_v2        0.48      0.02      0.39        candidate
direct_broad_patch_v1           0.21      0.41      0.10        suppressed
```

## 观察重点

不要看系统有没有很多图。要看：

```text
失败是否导致了变异？
变异是否导致了子策略？
子策略是否经过竞赛？
竞赛是否改变了下一次采样？
```

# Version: AntCode v0.4.0

## 名称

**Self-Evolving Code Agent**

## 版本定位

v0.4.0 是 AntCode 从"机制验证实验"走向"真实自我进化"的版本。

v0.3.2 证明了失败能改变策略结构。v0.4.0 证明了策略能驱动真实 LLM 修改自己的代码，并通过验证管线确认修改有效。

```text
核心问题：
策略进化能否驱动真实 LLM 产出有效代码变更，并让系统自我改进？
```

## 与 v0.3.2 的关系

```text
v0.3.2 (已验证):
ExperienceKey → StrategyGenome → mock Attempt → RewardBundle
→ FailureMode → Mutation → Tournament

v0.4.0 (新增):
ExperienceKey → StrategyGenome → real LLM Attempt → patch + typecheck + test
→ RewardBundle (含 token 成本) → 自适应 Mutation → Tournament
→ 成功 patch 自动合并回源码 → 下一轮 LLM 看到进化后的代码
```

## v0.4.0 新增能力

### 1. 真实 LLM Worker
- 接入 OpenAI 兼容 API（/responses 端点，流式请求）
- LLM 输出完整文件内容，验证管线 apply → typecheck → test
- 成功 patch 自动合并回项目源码（autoMerge）
- `--real` flag 切换 mock/real 模式

### 2. 并发执行
- 每轮并发 N 个 attempt（ANTCODE_CONCURRENCY 可配）
- 每个 attempt 使用隔离的 workbench slot，互不干扰

### 3. 自适应变异
- boundary_blocked 时从实际 diff 大小推断合理值（+20% margin），不再线性 *1.5
- patch_too_broad 时根据实际 diff 缩减到 80%
- context_underread 时根据实际文件数调整 max_files

### 4. 成本感知进化
- Token 消耗纳入 RewardBundle.cost
- 高 token 消耗扣分（最多 -0.15），cache hit 率高加分（+0.05）
- 进化压力自然淘汰高消耗低收益策略

### 5. Prompt CMU 架构（Context Minimum Unit）
- U0: 系统指令（永不变）
- U1: 类型定义（源码变才变）
- U2[]: 目标文件（每文件独立单元）
- U3: 任务描述（每 ExperienceKey 一个）
- U4: 共享知识（跨 attempt 经验交换）
- U5: 策略约束（每 genome 不同，永远最后）
- 并发请求 U0-U4 一致，只有 U5 不同 → 最大化 prefix cache hit

### 6. 主动觅食
- tiny/small 策略只给签名 + 前 60 行预览
- medium/large 策略给完整文件
- reference 文件永远只给签名

### 7. 上下文交换
- 从历史 attempt 提取成功/失败经验
- 结构化注入 prompt 的 U4 单元
- 后续 attempt 能看到"什么有效、什么踩坑"

## 已验证

1. 三个 ExperienceKey 全部至少一次 success + merge
2. 代码真的在进化自己（mutation.ts 拆分、cli.ts 加命令、types.ts 加类型）
3. Tournament 在真实 LLM 数据上正确 promote/suppress
4. 自适应变异一代突破 boundary（vs 旧版需要 3-4 代）
5. 信息素挥发 + 负信息素在工作

## 明确失败

如果出现以下情况，v0.4.0 失败：

1. 真实 LLM 的成功率不高于随机（需 >30%）
2. 自动合并的代码破坏了项目可运行性
3. Token 成本持续增长但成功率不增长
4. 进化方向与 mock 完全矛盾且无法解释

# Version: AntCode v0.5.0

## 名称

**Autonomous Self-Evolving Code Agent**

## 版本定位

v0.5.0 是 AntCode 从"能自我进化"走向"高效自主进化"的版本。

```text
v0.4.0: 证明了 LLM 能修改自己的代码并通过验证
v0.5.0: 让这个过程更高效、更智能、更便宜
```

## 与 v0.4.0 的关系

```text
v0.4.0:
预定义任务 → LLM 输出完整文件 → 外部验证 → 合并
成功率 44%, cache hit 0%, $0.33/attempt

v0.5.0:
LLM 自主探索 → 通用工具(read/edit/bash/grep/find/ls) → 自主验证 → 合并
多 agent 分工协作 → 共享发现 → 策略收敛淘汰
成功率 56.7%, cache hit 47.7%, $0.16/attempt
```

## v0.5.0 新增能力

### 1. 通用工具集 + Operations 抽象
- 7 个通用工具：read, write, edit(多段替换), bash, grep, find, ls + done
- Operations 接口解耦 I/O，可扩展到远程/Docker/其他语言
- 参考 pi-mono 的 ToolDefinition 设计，工具自带 prompt 元数据

### 2. Tool Use Loop（多轮 Agent 循环）
- LLM 通过原生 function calling 调用工具
- 多轮对话：探索 → 编辑 → 验证 → 修复 → done
- 最后一轮强制 done，避免无限探索
- 中断时保留已收集的文件变更

### 3. 自主探索模式
- 去掉预定义任务，LLM 自己发现问题并修复
- 高层目标驱动："改进代码质量"
- LLM 看到代码后决定改什么，比外部指定更精准

### 4. 对话历史压缩
- 早期 read 结果截断到 50 行
- 早期 bash 结果截断到 20 行
- 早期 write/edit 参数压缩
- 保持最近 6 条消息完整

### 5. 策略收敛
- Tournament min_samples 降到 2，加速判定
- 每个 goal 最多 8 个 genome，超过强制淘汰最弱的
- 37 个 genome 收敛到 7 active + 5 candidate + 25 suppressed

### 6. 多 Agent 协作
- 并发 agent 分配不同探索区域（storage、mutation、agent、cli）
- 共享发现板：成功修复和已知问题对其他 agent 可见
- 避免重复工作

### 7. Prompt Cache 优化
- prompt_cache_key 路由同一 task 到同一机器
- system prompt + tools 作为稳定 prefix
- 对话压缩保持 prefix 稳定
- Cache hit 从 0% 提升到 47.7%（peak 63.6%）

## 30 轮实验数据

```text
成功率:        56.7% (17/30 success, 17 auto-merged)
Cache hit:     47.7% (peak 63.6%)
成本:          $4.78 total, $0.16/attempt
Avg reward:    0.582
Avg diff:      10 lines
Genome 收敛:   7 active, 5 candidate, 25 suppressed
```

### 策略排名

```text
refactor_big_bang_v6    3/3  100%  avg_reward=0.712
type_fix_broad_v6       3/3  100%  avg_reward=0.674
scout_then_narrow_v2    3/3  100%  avg_reward=0.665
refactor_big_bang_v1    2/2  100%  avg_reward=0.679
type_fix_careful_v1     2/3   67%  avg_reward=0.626
```

### LLM 自我改进的代码

- verify.ts: mergeToProject/mergeFilesToProject 错误处理
- verify.ts: captureBaseline 异常包装
- mutation.ts: child strategy id 推导修复
- mutationOps.ts: context_underread 变更追踪修复
- crossover.ts: JSON clone → structuredClone
- storage.ts: 结构化 StorageError + writeJson 加固
- taskGen.ts: 输入验证 + 结构化错误处理
- index.ts: 补全缺失模块导出

## 进化发现

1. 大胆探索型策略（big_bang）在自主模式下表现最好——敢于读更多文件、做更大改动
2. 精准修复型策略（type_fix）稳定但保守——找小问题修
3. 保守增量型策略（incremental）效率最低——花太多轮探索但不敢改
4. 进化压力正确淘汰了无效策略，25 个被 suppress

## 明确失败条件

1. 成功率持续低于 30%
2. Cache hit 低于 20%
3. 成本/attempt 超过 $0.50
4. 自动合并的代码破坏项目可运行性
5. Genome 数量无限膨胀

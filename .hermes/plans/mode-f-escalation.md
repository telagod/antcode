# Mode F: 分布式自主提权 (Boundary Escalation)

## 核心洞察
任务的 `target_files` 是**人/任务生成器的猜测**。Agent 上下文里看到的真相往往更准。
越界 = 信号，不是错误。需要：
1. Agent **解释为什么越界**（reason）
2. **轻量 judge** 自动批/驳（不要人审批 = 分布式自主）
3. 拒绝时进 `boundary_violations`，批准时进 `escalations_approved`，进 reward signal

## 数据模型

```ts
// types.ts
type EscalationRequest = {
  file: string;
  reason: string;          // agent 在 manifest 写的理由
  verdict: "approved" | "rejected" | "conditional";
  judge_score: number;     // 0-1
  judge_rationale: string; // judge 的简短解释
};

interface Attempt {
  ...
  escalations?: EscalationRequest[];
  boundary_violations: string[];  // 仍然保留 = 没有 reason 就被拦下的
}
```

## Agent 协议（在 prompt 加一段）

```
If you need to modify a file NOT in your task.target_files, you MUST add a line to your final manifest notes:

  ESCALATE: <relative_path> | <one-line reason why this file must change for the task>

Example:
  ESCALATE: src/reward/index.ts | dead placeholder reachable from same dead-code task; deleting reward.ts shim leaves dangling import otherwise.

Files mentioned in ESCALATE will be reviewed by a judge. Files modified without ESCALATE will be silently dropped.
```

## CLI Merge 逻辑（替换现 P1 白名单）

```ts
// 1. 解析 manifest.notes 里所有 ESCALATE: <file> | <reason>
const escalations = parseEscalations(notes);

// 2. 对 mergeFiles 每个文件分类
for (file of mergeFiles) {
  if (inTarget || sameDir || isSidecar) {
    allowed.push(file);                  // 原 P1 白名单
  } else if (escalations[file]) {
    pending.push({file, reason: escalations[file]});  // 等 judge
  } else {
    rejected.push(file);                 // 没解释就 reject
  }
}

// 3. 批量 judge（一次 LLM call，传所有 pending）
const verdicts = await judgeEscalations(task, pending);

// 4. 应用判决
for (v of verdicts) {
  if (v.verdict === "approved") allowed.push(v.file);
  attempt.escalations.push(v);
}
for (f of rejected) attempt.boundary_violations.push(f);
```

## Judge 提示模板

```
You are reviewing a code agent's request to modify files outside its assigned scope.

Task: {task.goal_pattern} on {task.target_files}
Task description: {task.description}

The agent wants to ALSO modify these files:

{for each pending}
- File: {file}
  Reason: {reason}
  Diff snippet: {first 30 lines of diff}

For each file, decide:
- approved: clearly necessary for the task (e.g., shared util, dependent file, broken import)
- rejected: unrelated change, drift, or scope creep
- conditional: tangentially related, accept but flag for review

Respond JSON:
[{"file": "...", "verdict": "approved|rejected|conditional", "score": 0.0-1.0, "rationale": "..."}]
```

## Reward 影响

```ts
// calculator.ts buildRewardBundle 改写：
const approvedExtras = (attempt.escalations || [])
  .filter(e => e.verdict === "approved").length;
const conditionalExtras = (attempt.escalations || [])
  .filter(e => e.verdict === "conditional").length;
const rejectedExtras = attempt.boundary_violations.length;

// 旧 alignment 用 files_changed 整体分母不公平：
// 一个 approved escalation 不应拉低 alignment。
const inScopeFiles = filesChanged.filter(f =>
  isInTarget(f) || isSameDir(f) || isSidecar(f) ||
  approvedSet.has(f)  // ✓ 提权批准的也算 in-scope
);
const alignment = inScopeFiles.length / filesChanged.length;

// guard_flags
if (rejectedExtras > 0) guard_flags.push("boundary_violation");
if (conditionalExtras > 0) guard_flags.push("scope_creep_minor");
// approved 不触发 flag

// bonus
if (approvedExtras > 0 && rejectedExtras === 0) {
  semantic += 0.10;  // "good judgment" bonus —— 看到了任务没看到的
  evidence.push(`escalated ${approvedExtras} files, all approved`);
}
```

## 落地步骤

1. types.ts 加 EscalationRequest + Attempt.escalations
2. cli.ts 加 parseEscalations() + judgeEscalations() + 重写 merge 白名单
3. realWorker.ts pi prompt 注入 ESCALATE 协议（refactor_module 等会越界的 goal_pattern 优先）
4. calculator.ts 改 alignment 公式包含 approved
5. 单元 spike：模拟 4 case
   - 越界无 ESCALATE → reject
   - 越界有 ESCALATE，judge approved → merge + bonus
   - 越界有 ESCALATE，judge rejected → reject + 仍计 violation
   - 同时有 approved + rejected → 部分 merge
6. 跑 5-iter v5 真实验证
7. 对比 v4: attempt #1 应当变 approved 而不是被拦

## 风险 / 抉择

- **judge 成本**：每个 attempt +1 LLM call。但只在有 escalation 时调用。
- **judge 自己也可能瞎**：用同款 model（claude-opus-4-7）问 task+diff，比纯规则准确率高很多。
- **escalation 滥用**：agent 可能对所有越界都写 ESCALATE 求降低门槛。judge_score 进 reward 就能压下去 —— 烂理由会被 reject + flag。
- **conditional 怎么用**：先记录，不影响 merge，后续看数据决定提到 reject 或降到 approved。

## 期望产出

- v5 5/5 attempts: reward range 应当扩到 [0.3, 1.0]
- attempt 类似 v4 #1 的 case：reward ≈ 0.90 而不是 0.55，guard 清空
- attempt 真正 drift（如 v3 #2 跑去改 crossover）：reward ≈ 0.40，guard=[boundary_violation]
- 拉开 σ ≥ 0.20 维持

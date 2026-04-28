import { Attempt, FailureMode, MutationEvent, PolicyConfig, RewardBundle, StrategyGenome } from "./types";
import { applyOneMutation } from "./mutationOps";

function cloneStrategyGenome(value: StrategyGenome): StrategyGenome {
  return structuredClone(value);
}

function nextId(prefix: string, n: number): string {
  return `${prefix}_${String(n).padStart(4, "0")}`;
}

export function canMutate(
  parent: StrategyGenome,
  rewards: RewardBundle[],
  policy: PolicyConfig,
): { ok: boolean; failureMode?: FailureMode; failureModes?: FailureMode[]; attempts?: string[]; reason?: string } {
  if (parent.status === "quarantined") return { ok: false, reason: "quarantined parent cannot reproduce" };

  const recent = rewards.filter((r) => r.strategy_genome_id === parent.id).slice(-8);
  const grouped = new Map<FailureMode, RewardBundle[]>();
  for (const r of recent) {
    if (r.failure_mode === "none") continue;
    if (r.guard_flags.some((f) => policy.mutation_threshold.forbid_if_guard_flags.includes(f))) {
      return { ok: false, reason: `guard flag forbids mutation: ${r.guard_flags.join(",")}` };
    }
    grouped.set(r.failure_mode, [...(grouped.get(r.failure_mode) ?? []), r]);
  }

  const triggered: FailureMode[] = [];
  const allAttempts: string[] = [];
  for (const [mode, rs] of grouped.entries()) {
    if (rs.length >= policy.mutation_threshold.min_same_failure_count) {
      const avgSemantic = rs.reduce((s, r) => s + r.semantic_confidence.score, 0) / rs.length;
      if (avgSemantic >= policy.mutation_threshold.min_avg_semantic_confidence || mode === "missing_test" || mode === "boundary_blocked") {
        triggered.push(mode);
        allAttempts.push(...rs.map((r) => r.attempt_id));
      }
    }
  }

  if (triggered.length === 0) return { ok: false, reason: "mutation threshold not reached" };
  return { ok: true, failureMode: triggered[0], failureModes: triggered, attempts: [...new Set(allAttempts)] };
}

export function mutateGenome(
  parent: StrategyGenome,
  failureMode: FailureMode,
  attempts: Attempt[],
  mutationIndex: number,
  extraFailureModes?: FailureMode[],
): { child: StrategyGenome; event: MutationEvent } {
  const child = cloneStrategyGenome(parent);
  child.parent_id = parent.id;
  child.generation = parent.generation + 1;
  child.status = "candidate";
  child.id = `${parent.id.replace(/_v\d+$/, "")}_v${child.generation}`;

  const changed: MutationEvent["mutation"]["changed"] = {};
  const allModes = [failureMode, ...(extraFailureModes ?? []).filter((m) => m !== failureMode)];
  const types: string[] = [];
  const hypotheses: string[] = [];

  for (const mode of allModes) {
    const result = applyOneMutation(child, mode, changed, attempts);
    types.push(result.type);
    hypotheses.push(result.hypothesis);
    if ((child.status as StrategyGenome["status"]) === "quarantined") break;
  }

  const type = types.length > 1 ? `compound[${types.join("+")}]` : (types[0] ?? "unknown_mutation");
  const hypothesis = hypotheses.join(" ");

  const keyHash = attempts[0]
    ? [
        attempts[0].experience_key.goal_pattern,
        attempts[0].experience_key.module_region,
        attempts[0].experience_key.error_pattern ?? "none",
        attempts[0].experience_key.context_shape.join("+"),
        attempts[0].experience_key.risk_level,
      ].join(":")
    : "unknown";

  const event: MutationEvent = {
    id: nextId("mut", mutationIndex),
    timestamp: new Date().toISOString(),
    parent_strategy: parent.id,
    child_strategy: child.id,
    triggered_by: {
      experience_key_hash: keyHash,
      failure_mode: failureMode,
      attempts: attempts.map((a) => a.id),
    },
    mutation: { type, changed },
    hypothesis,
    status: (child.status as StrategyGenome["status"]) === "quarantined" ? "quarantined" : "candidate",
  };

  return { child, event };
}

import type { Attempt, FailureMode, MutationEvent, StrategyGenome } from "./types";

export interface MutationEvidence {
  actual_diff_lines?: number;
  actual_files_changed?: number;
  boundary_violations?: string[];
  notes?: string[];
}

export interface MutationRule {
  type: string;
  field: string;
  value?: unknown;
  delta?: number;
  min?: number;
  max?: number;
  search?: string;
  replace?: string;
  exclude?: string[];
}

export interface MutationRecipe {
  if_failure_mode: FailureMode;
  mutation_type: string;
  hypothesis_template: string;
  rules: MutationRule[];
}

function extractEvidence(attempts: Attempt[]): MutationEvidence {
  if (!attempts.length) return {};
  const maxDiff = Math.max(...attempts.map((a) => a.diff_lines));
  const maxFiles = Math.max(...attempts.map((a) => a.files_changed.length));
  const violations = attempts.flatMap((a) => a.boundary_violations);
  const notes = attempts.flatMap((a) => a.notes);
  return { actual_diff_lines: maxDiff, actual_files_changed: maxFiles, boundary_violations: violations, notes };
}

function getField(obj: StrategyGenome, path: string): unknown {
  return path.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), obj);
}

function setField(obj: StrategyGenome, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce((o: any, k) => o[k], obj);
  target[last] = value;
}

function recordChange(
  changed: MutationEvent["mutation"]["changed"],
  field: string,
  from: unknown,
  to: unknown,
): void {
  changed[field] = { from, to };
}

function executeRule(
  genome: StrategyGenome,
  rule: MutationRule,
  changed: MutationEvent["mutation"]["changed"],
  evidence: MutationEvidence,
): boolean {
  const current = getField(genome, rule.field);

  switch (rule.type) {
    case "set": {
      recordChange(changed, rule.field, current, rule.value);
      setField(genome, rule.field, rule.value);
      return true;
    }
    case "toggle": {
      const val = !!current;
      recordChange(changed, rule.field, val, !val);
      setField(genome, rule.field, !val);
      return true;
    }
    case "prepend": {
      const arr = Array.isArray(current) ? [...current] : [];
      const val = rule.value as string;
      if (!arr.includes(val)) arr.unshift(val);
      recordChange(changed, rule.field, current, arr);
      setField(genome, rule.field, arr);
      return true;
    }
    case "push": {
      const arr = Array.isArray(current) ? [...current] : [];
      const val = rule.value as string;
      if (!arr.includes(val)) arr.push(val);
      recordChange(changed, rule.field, current, arr);
      setField(genome, rule.field, arr);
      return true;
    }
    case "dedupe": {
      if (!Array.isArray(current)) return false;
      const exclude = new Set(rule.exclude ?? []);
      const arr = current.filter((x) => !exclude.has(x));
      // if value specified, ensure it's present after deduping
      if (rule.value !== undefined && !arr.includes(rule.value as string)) {
        arr.unshift(rule.value as string);
      }
      recordChange(changed, rule.field, current, arr);
      setField(genome, rule.field, arr);
      return true;
    }
    case "adjust": {
      const num = typeof current === "number" ? current : 0;
      let next = num + (rule.delta ?? 0);
      if (rule.min !== undefined) next = Math.max(rule.min, next);
      if (rule.max !== undefined) next = Math.min(rule.max, next);
      recordChange(changed, rule.field, num, next);
      setField(genome, rule.field, next);
      return true;
    }
    case "replace": {
      if (typeof current !== "string") return false;
      const next = current.replace(rule.search ?? "", rule.replace ?? "");
      recordChange(changed, rule.field, current, next);
      setField(genome, rule.field, next);
      return true;
    }
    case "clamp": {
      if (typeof current !== "number") return false;
      let next = current;
      if (rule.min !== undefined) next = Math.max(rule.min, next);
      if (rule.max !== undefined) next = Math.min(rule.max, next);
      recordChange(changed, rule.field, current, next);
      setField(genome, rule.field, next);
      return true;
    }
    case "downgrade_enum": {
      // e.g., "large" → "medium" → "small" → "tiny"
      const order = (rule.value as string[] | undefined) ?? ["large", "medium", "small", "tiny"];
      const idx = order.indexOf(current as string);
      const next = idx > 0 ? order[idx - 1] : order[order.length - 1];
      recordChange(changed, rule.field, current, next);
      setField(genome, rule.field, next);
      return true;
    }
    case "use_evidence": {
      // Special: adjust based on evidence value
      if (rule.field === "boundary_strategy.max_diff_lines" && evidence.actual_diff_lines != null) {
        const next = Math.min(
          rule.max ?? Infinity,
          Math.ceil(evidence.actual_diff_lines * (rule.delta ?? 1.2)),
        );
        recordChange(changed, rule.field, current, next);
        setField(genome, rule.field, next);
        return true;
      }
      if (rule.field === "context_strategy.max_files" && evidence.actual_files_changed != null) {
        const next = Math.min(
          rule.max ?? Infinity,
          Math.max(rule.min ?? 0, evidence.actual_files_changed + (rule.delta ?? 2)),
        );
        recordChange(changed, rule.field, current, next);
        setField(genome, rule.field, next);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// ── Default mutation recipes (extracted from former hard-coded logic) ──

export const DEFAULT_MUTATION_RECIPES: MutationRecipe[] = [
  {
    if_failure_mode: "missing_test",
    mutation_type: "validation_order_change",
    hypothesis_template: "Patching happened before expected behavior was locked by tests.",
    rules: [
      { type: "prepend", field: "validation_strategy.required", value: "write_or_update_targeted_test" },
      { type: "prepend", field: "validation_strategy.required", value: "run_targeted_test" },
      { type: "dedupe", field: "validation_strategy.required", exclude: ["targeted_test", "write_or_update_targeted_test", "run_targeted_test"] },
    ],
  },
  {
    if_failure_mode: "context_underread",
    mutation_type: "context_expansion",
    hypothesis_template: "Strategy under-read dependencies (needed ~{files_needed} files).",
    rules: [
      { type: "prepend", field: "context_strategy.read_order", value: "critical_dependency_scan" },
      { type: "use_evidence", field: "context_strategy.max_files", min: 3, max: 14, delta: 2 },
    ],
  },
  {
    if_failure_mode: "boundary_blocked",
    mutation_type: "boundary_adaptive_expansion",
    hypothesis_template: "Boundary too narrow (actual diff={diff}, was max={old_max}).",
    rules: [
      { type: "set", field: "boundary_strategy.allowed_file_policy", value: "affected_module_plus_tests_plus_one_hop_dependency" },
      { type: "use_evidence", field: "boundary_strategy.max_diff_lines", max: 500, delta: 1.2 },
    ],
  },
  {
    if_failure_mode: "patch_too_broad",
    mutation_type: "patch_adaptive_reduction",
    hypothesis_template: "Patch too broad (actual diff={diff}, shrinking).",
    rules: [
      { type: "downgrade_enum", field: "action_strategy.patch_granularity", value: ["large", "medium", "small", "tiny"] },
      { type: "use_evidence", field: "boundary_strategy.max_diff_lines", max: 500, delta: 0.8 },
      { type: "clamp", field: "boundary_strategy.max_diff_lines", min: 80 },
    ],
  },
  {
    if_failure_mode: "semantic_miss",
    mutation_type: "semantic_evidence_tightening",
    hypothesis_template: "Tests passed without proving goal. Evidence: {notes}",
    rules: [
      { type: "push", field: "reward_profile.optimize_for", value: "explicit_goal_evidence" },
    ],
  },
  {
    if_failure_mode: "reward_hacking",
    mutation_type: "quarantine",
    hypothesis_template: "Reward hacking signal detected; preserved only for audit.",
    rules: [
      { type: "set", field: "status", value: "quarantined" },
    ],
  },
];

// ── Interpreter ──

export function applyOneMutation(
  child: StrategyGenome,
  failureMode: FailureMode,
  changed: MutationEvent["mutation"]["changed"],
  attempts: Attempt[] = [],
  recipes = DEFAULT_MUTATION_RECIPES,
): { type: string; hypothesis: string } {
  const evidence = extractEvidence(attempts);
  const recipe = recipes.find((r) => r.if_failure_mode === failureMode);

  if (!recipe) {
    return { type: "unknown_mutation", hypothesis: "Mutation generated from repeated failure feedback." };
  }

  let anyApplied = false;
  for (const rule of recipe.rules) {
    const ok = executeRule(child, rule, changed, evidence);
    if (ok) anyApplied = true;
  }

  if (!anyApplied) {
    return { type: "unknown_mutation", hypothesis: "Mutation generated from repeated failure feedback." };
  }

  // Build hypothesis from template
  let hypothesis = recipe.hypothesis_template;
  hypothesis = hypothesis.replace("{files_needed}", String(evidence.actual_files_changed ?? "?"));
  hypothesis = hypothesis.replace("{diff}", String(evidence.actual_diff_lines ?? "?"));
  hypothesis = hypothesis.replace("{old_max}", String(getField(child, "boundary_strategy.max_diff_lines") ?? "?"));
  const weakNotes = (evidence.notes ?? []).filter((n) => n.includes("weak") || n.includes("evidence")).slice(0, 2);
  hypothesis = hypothesis.replace("{notes}", weakNotes.join("; ") || "low semantic score");

  return { type: recipe.mutation_type, hypothesis };
}

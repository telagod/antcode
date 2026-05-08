import type { Attempt, FailureMode, MutationEvent, StrategyGenome } from "./types";
import { getField, setField } from "./mutationOps/fieldAccess";
import { DEFAULT_MUTATION_RECIPES, type MutationEvidence, type MutationRule } from "./mutationOps/recipes";

// ── Re-exports preserving the public API surface ──
//
// Field-access helpers (path traversal with prototype-pollution guards)
// live in `./mutationOps/fieldAccess`. Mutation-rule data structures and
// the default failure-mode → mutation recipe table live in
// `./mutationOps/recipes`. Both are re-exported here so the existing
// `export * from "./mutationOps"` in `src/index.ts` continues to surface
// the same symbols as before the split.
export {
  getField,
  setField,
  tryGetField,
  trySetField,
  type GetFieldResult,
  type SetFieldResult,
} from "./mutationOps/fieldAccess";
export {
  DEFAULT_MUTATION_RECIPES,
  type MutationEvidence,
  type MutationRule,
  type MutationRecipe,
} from "./mutationOps/recipes";

function extractEvidence(attempts: Attempt[]): MutationEvidence {
  if (!attempts.length) return {};
  const maxDiff = Math.max(...attempts.map((a) => a.diff_lines));
  const maxFiles = Math.max(...attempts.map((a) => a.files_changed.length));
  const violations = attempts.flatMap((a) => a.boundary_violations);
  const notes = attempts.flatMap((a) => a.notes);
  return { actual_diff_lines: maxDiff, actual_files_changed: maxFiles, boundary_violations: violations, notes };
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
  const current = getField<unknown>(genome, rule.field);

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
  hypothesis = hypothesis.replace("{old_max}", String(getField<number>(child, "boundary_strategy.max_diff_lines") ?? "?"));
  const weakNotes = (evidence.notes ?? []).filter((n) => n.includes("weak") || n.includes("evidence")).slice(0, 2);
  hypothesis = hypothesis.replace("{notes}", weakNotes.join("; ") || "low semantic score");

  return { type: recipe.mutation_type, hypothesis };
}

import { Attempt, FailureMode, MutationEvent, StrategyGenome } from "./types";

export interface MutationEvidence {
  actual_diff_lines?: number;
  actual_files_changed?: number;
  boundary_violations?: string[];
  notes?: string[];
}

function extractEvidence(attempts: Attempt[]): MutationEvidence {
  if (!attempts.length) return {};
  const maxDiff = Math.max(...attempts.map((a) => a.diff_lines));
  const maxFiles = Math.max(...attempts.map((a) => a.files_changed.length));
  const violations = attempts.flatMap((a) => a.boundary_violations);
  const notes = attempts.flatMap((a) => a.notes);
  return { actual_diff_lines: maxDiff, actual_files_changed: maxFiles, boundary_violations: violations, notes };
}

export function applyOneMutation(
  child: StrategyGenome,
  failureMode: FailureMode,
  changed: MutationEvent["mutation"]["changed"],
  attempts: Attempt[] = [],
): { type: string; hypothesis: string } {
  const evidence = extractEvidence(attempts);

  if (failureMode === "missing_test") {
    const before = [...child.validation_strategy.required];
    child.validation_strategy.required = [
      "write_or_update_targeted_test",
      "run_targeted_test",
      ...before.filter(
        (x) => x !== "targeted_test" && x !== "write_or_update_targeted_test" && x !== "run_targeted_test",
      ),
    ];
    changed["validation_strategy.required"] = { from: before, to: child.validation_strategy.required };
    return { type: "validation_order_change", hypothesis: "Patching happened before expected behavior was locked by tests." };
  } else if (failureMode === "context_underread") {
    const beforeOrder = [...child.context_strategy.read_order];
    const beforeMax = child.context_strategy.max_files;
    if (!child.context_strategy.read_order.includes("critical_dependency_scan")) {
      child.context_strategy.read_order.unshift("critical_dependency_scan");
    }
    const filesNeeded = evidence.actual_files_changed ?? 0;
    const bump = filesNeeded > 0 ? Math.max(3, filesNeeded + 2) : 3;
    child.context_strategy.max_files = Math.min(14, child.context_strategy.max_files + bump);
    const afterOrder = [...child.context_strategy.read_order];
    changed["context_strategy.read_order"] = { from: beforeOrder, to: afterOrder };
    changed["context_strategy.max_files"] = { from: beforeMax, to: child.context_strategy.max_files };
    return { type: "context_expansion", hypothesis: `Strategy under-read dependencies (needed ~${filesNeeded} files).` };
  } else if (failureMode === "boundary_blocked") {
    const beforePolicy = child.boundary_strategy.allowed_file_policy;
    const beforeLines = child.boundary_strategy.max_diff_lines;
    child.boundary_strategy.allowed_file_policy = "affected_module_plus_tests_plus_one_hop_dependency";
    // adaptive: jump to actual diff + 20% margin instead of blind *1.5
    if (evidence.actual_diff_lines && evidence.actual_diff_lines > child.boundary_strategy.max_diff_lines) {
      child.boundary_strategy.max_diff_lines = Math.min(500, Math.ceil(evidence.actual_diff_lines * 1.2));
    } else {
      child.boundary_strategy.max_diff_lines = Math.min(500, Math.ceil(child.boundary_strategy.max_diff_lines * 1.5));
    }
    changed["boundary_strategy.allowed_file_policy"] = { from: beforePolicy, to: child.boundary_strategy.allowed_file_policy };
    changed["boundary_strategy.max_diff_lines"] = { from: beforeLines, to: child.boundary_strategy.max_diff_lines };
    return { type: "boundary_adaptive_expansion", hypothesis: `Boundary too narrow (actual diff=${evidence.actual_diff_lines ?? "?"}, was max=${beforeLines}).` };
  } else if (failureMode === "patch_too_broad") {
    const beforeGranularity = child.action_strategy.patch_granularity;
    const beforeLines = child.boundary_strategy.max_diff_lines;
    child.action_strategy.patch_granularity = beforeGranularity === "large" ? "medium" : beforeGranularity === "medium" ? "small" : "tiny";
    // adaptive: if we know actual diff, shrink to 80% of it; otherwise 0.7x
    if (evidence.actual_diff_lines && evidence.actual_diff_lines > 100) {
      child.boundary_strategy.max_diff_lines = Math.max(80, Math.ceil(evidence.actual_diff_lines * 0.8));
    } else {
      child.boundary_strategy.max_diff_lines = Math.max(80, Math.floor(child.boundary_strategy.max_diff_lines * 0.7));
    }
    changed["action_strategy.patch_granularity"] = { from: beforeGranularity, to: child.action_strategy.patch_granularity };
    changed["boundary_strategy.max_diff_lines"] = { from: beforeLines, to: child.boundary_strategy.max_diff_lines };
    return { type: "patch_adaptive_reduction", hypothesis: `Patch too broad (actual diff=${evidence.actual_diff_lines ?? "?"}, shrinking).` };
  } else if (failureMode === "semantic_miss") {
    const before = [...child.reward_profile.optimize_for];
    if (!child.reward_profile.optimize_for.includes("explicit_goal_evidence")) {
      child.reward_profile.optimize_for.push("explicit_goal_evidence");
    }
    changed["reward_profile.optimize_for"] = { from: before, to: child.reward_profile.optimize_for };
    const weakNotes = (evidence.notes ?? []).filter((n) => n.includes("weak") || n.includes("evidence")).slice(0, 2);
    return { type: "semantic_evidence_tightening", hypothesis: `Tests passed without proving goal. Evidence: ${weakNotes.join("; ") || "low semantic score"}.` };
  } else if (failureMode === "reward_hacking") {
    const before = child.status;
    child.status = "quarantined";
    changed["status"] = { from: before, to: child.status };
    return { type: "quarantine", hypothesis: "Reward hacking signal detected; preserved only for audit." };
  }
  return { type: "unknown_mutation", hypothesis: "Mutation generated from repeated failure feedback." };
}

// Spike: validate alignment + boundary changes work as designed.
// Run: npx tsx /tmp/antcode/scripts/test-alignment-spike.ts

import { computeAlignment, buildRewardBundle } from "../src/reward/calculator";
import type { Attempt } from "../src/types";

function mkAttempt(overrides: Partial<Attempt>): Attempt {
  return {
    id: "test_attempt",
    timestamp: new Date().toISOString(),
    experience_key: { goal_pattern: "refactor_module", module_region: "test", context_shape: [], risk_level: "low" },
    strategy_genome_id: "test_genome",
    worker: "other",
    result: "success",
    files_changed: [],
    diff_lines: 10,
    tests_added: 0,
    commands_run: [],
    boundary_violations: [],
    notes: ["tokens:in=1000,out=500,cached=200"],
    target_files: [],
    ...overrides,
  };
}

function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? "  " + detail : ""}`);
  if (!cond) process.exitCode = 1;
}

console.log("\n━━━ computeAlignment ━━━");
{
  const r = computeAlignment([], ["src/foo.ts"]);
  check("empty files → 0/0", r.alignment === 0 && r.containment === 0, JSON.stringify(r));
}
{
  const r = computeAlignment(["src/foo.ts"], []);
  check("empty target → 1/1 (legacy)", r.alignment === 1 && r.containment === 1, JSON.stringify(r));
}
{
  const r = computeAlignment(["src/foo.ts"], ["src/foo.ts"]);
  check("perfect match → 1/1", r.alignment === 1 && r.containment === 1, JSON.stringify(r));
}
{
  const r = computeAlignment(["src/bar.ts"], ["src/foo.ts"]);
  check("same dir → align=0 contain=1", r.alignment === 0 && r.containment === 1, JSON.stringify(r));
}
{
  const r = computeAlignment(["src/runtime/piModel.ts"], ["src/sampler.ts"]);
  check("different dir → align=0 contain=0 (DRIFT)", r.alignment === 0 && r.containment === 0, JSON.stringify(r));
}
{
  const r = computeAlignment(["src/foo.ts", "src/foo.test.ts"], ["src/foo.ts"]);
  check("with test sidecar → align=0.5 contain=1", r.alignment === 0.5 && r.containment === 1, JSON.stringify(r));
}
{
  const r = computeAlignment(["src/foo.ts", "src/runtime/piModel.ts"], ["src/foo.ts"]);
  check("half drift → align=0.5 contain=0.5", r.alignment === 0.5 && r.containment === 0.5, JSON.stringify(r));
}

console.log("\n━━━ buildRewardBundle ━━━");
// Case A: success + perfect alignment
{
  const a = mkAttempt({
    files_changed: ["src/foo.ts"],
    target_files: ["src/foo.ts"],
    result: "success",
  });
  const b = buildRewardBundle(a);
  console.log(`A: perfect alignment success → reward=${b.reward.toFixed(3)} sem=${b.semantic_confidence.score.toFixed(3)}`);
  console.log(`   evidence: ${b.semantic_confidence.evidence.join(" | ")}`);
  check("A reward ≥ 0.85", b.reward >= 0.85);
  check("A perfect alignment in evidence",
    b.semantic_confidence.evidence.some((e) => e.includes("perfect alignment")));
}
// Case B: success but drifted (the actual bug we observed)
{
  const a = mkAttempt({
    files_changed: ["src/runtime/piModel.ts"],   // agent went WAY out of scope
    target_files: ["src/sampler.ts"],
    result: "success",
  });
  const b = buildRewardBundle(a);
  console.log(`B: drifted success → reward=${b.reward.toFixed(3)} sem=${b.semantic_confidence.score.toFixed(3)}`);
  console.log(`   guard_flags: ${b.guard_flags.join(",")}`);
  console.log(`   evidence: ${b.semantic_confidence.evidence.join(" | ")}`);
  check("B reward < 0.65 (drift penalized)", b.reward < 0.65);
  check("B has goal_drift flag", b.guard_flags.includes("goal_drift"));
}
// Case C: legacy attempt with no target_files (must not regress)
{
  const a = mkAttempt({
    files_changed: ["src/whatever.ts"],
    target_files: [],
    result: "success",
  });
  const b = buildRewardBundle(a);
  console.log(`C: no target → reward=${b.reward.toFixed(3)} sem=${b.semantic_confidence.score.toFixed(3)}`);
  check("C no goal_drift flag", !b.guard_flags.includes("goal_drift"));
}
// Case D: cross-task boundary signal — task is sampler.ts but agent edits sampler + piModel
{
  const a = mkAttempt({
    files_changed: ["src/sampler.ts", "src/runtime/piModel.ts"],
    target_files: ["src/sampler.ts"],
    result: "success",
  });
  const b = buildRewardBundle(a);
  console.log(`D: half drift → reward=${b.reward.toFixed(3)} sem=${b.semantic_confidence.score.toFixed(3)}`);
  console.log(`   evidence: ${b.semantic_confidence.evidence.join(" | ")}`);
  check("D reward roughly mid (0.5–0.85)", b.reward > 0.5 && b.reward < 0.85);
}

console.log("\n━━━ done ━━━");

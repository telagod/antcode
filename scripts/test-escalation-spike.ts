// Mode F (boundary escalation) spike test.
// Validates that:
//   - parseEscalations correctly extracts ESCALATE: <file> | <reason> lines
//   - approved escalations count as in-target (alignment improves)
//   - rejected escalations still count as drift
//   - good-judgment bonus fires when all escalations approved
//
// Does NOT call the LLM judge (would need network). Mocks Attempt.escalations
// directly to test the calculator/parse logic.
//
// Usage: npx tsx scripts/test-escalation-spike.ts

import "dotenv/config";
import { computeAlignment, buildRewardBundle } from "../src/reward/calculator";
import { Attempt } from "../src/types";
import { DEFAULT_WEIGHTS } from "../src/reward/weights";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`✅ ${name}`);
    pass++;
  } else {
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

console.log("\n━━━ parseEscalations (re-implemented locally for spike) ━━━");
function parseEscalations(notes: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const note of notes) {
    const m = note.match(/^\s*ESCALATE:\s*([^|]+?)\s*\|\s*(.+)$/);
    if (m) {
      const file = m[1].trim();
      const reason = m[2].trim();
      if (file && reason) out.set(file, reason);
    }
  }
  return out;
}

const notes1 = [
  "Fixed dead code in src/reward.ts",
  "ESCALATE: src/reward/index.ts | dead placeholder, also needs deletion",
  "ESCALATE: src/types.ts | extracted helper requires shared type",
  "tokens:in=100,out=200,cached=0",
];
const parsed = parseEscalations(notes1);
check("parses 2 ESCALATE lines", parsed.size === 2, `got ${parsed.size}`);
check("parses path correctly", parsed.get("src/reward/index.ts") === "dead placeholder, also needs deletion");
check("parses second line", parsed.get("src/types.ts")?.includes("shared type") ?? false);

const notes2 = ["ESCALATE: src/foo.ts ;; bad delimiter", "ESCALATE: foo.ts | "];
check("rejects malformed lines (no |, empty reason)", parseEscalations(notes2).size === 0);

console.log("\n━━━ computeAlignment with approved set ━━━");
let r = computeAlignment(["src/foo.ts", "src/bar.ts"], ["src/foo.ts"], new Set(["src/bar.ts"]));
check(
  "approved file counts as in-target → alignment=1",
  r.alignment === 1 && r.containment === 1,
  `got align=${r.alignment} contain=${r.containment}`,
);

r = computeAlignment(["src/foo.ts", "src/baz.ts"], ["src/foo.ts"], new Set());
check(
  "without approved → alignment 0.5 (1 in target, 1 same-dir contained)",
  r.alignment === 0.5 && r.containment === 1,
  `got align=${r.alignment} contain=${r.containment}`,
);

const r2 = computeAlignment(["src/foo.ts", "other/baz.ts"], ["src/foo.ts"], new Set());
check(
  "without approved + different dir → drift signal (containment=0.5)",
  r2.alignment === 0.5 && r2.containment === 0.5,
  `got align=${r2.alignment} contain=${r2.containment}`,
);

r = computeAlignment(["src/foo.ts", "src/baz.ts"], ["src/foo.ts"], new Set(["src/baz.ts"]));
check(
  "same files but with approved → alignment=1",
  r.alignment === 1 && r.containment === 1,
  `got align=${r.alignment} contain=${r.containment}`,
);

console.log("\n━━━ buildRewardBundle: 4 cases ━━━");

function makeAttempt(overrides: Partial<Attempt>): Attempt {
  return {
    id: "test_attempt",
    timestamp: new Date().toISOString(),
    experience_key: {
      goal_pattern: "remove_dead_code",
      module_region: "reward",
      context_shape: ["type_definitions"],
      risk_level: "low",
    },
    strategy_genome_id: "test_genome",
    worker: "other",
    result: "success",
    files_changed: [],
    diff_lines: 10,
    tests_added: 0,
    commands_run: [],
    boundary_violations: [],
    notes: [],
    ...overrides,
  };
}

// Case A: approved escalation — agent's judgment validated
const caseA = makeAttempt({
  files_changed: ["src/reward.ts", "src/reward/index.ts"],
  target_files: ["src/reward.ts"],
  escalations: [
    {
      file: "src/reward/index.ts",
      reason: "dead placeholder, also needs deletion",
      verdict: "approved",
      judge_score: 0.9,
      judge_rationale: "shim and placeholder are both dead code from same task",
    },
  ],
});
const bundleA = buildRewardBundle(caseA, DEFAULT_WEIGHTS);
console.log(
  `  A (approved escalation): reward=${bundleA.reward.toFixed(3)}  sem=${bundleA.semantic_confidence.score.toFixed(3)}  guard=${JSON.stringify(bundleA.guard_flags)}`,
);
console.log(`     evidence: ${bundleA.semantic_confidence.evidence.join(" | ")}`);
check("A: no goal_drift flag", !bundleA.guard_flags.includes("goal_drift"));
check("A: alignment evidence shows 1.00", bundleA.semantic_confidence.evidence.some((e) => e.includes("alignment=1.00")));
check("A: good judgment bonus fired", bundleA.semantic_confidence.evidence.some((e) => e.includes("good judgment")));

// Case B: rejected escalation — drift caught
const caseB = makeAttempt({
  files_changed: ["src/foo.ts", "src/unrelated.ts"],
  target_files: ["src/foo.ts"],
  boundary_violations: ["src/unrelated.ts"],
  escalations: [
    {
      file: "src/unrelated.ts",
      reason: "wanted to also fix this thing I noticed",
      verdict: "rejected",
      judge_score: 0.1,
      judge_rationale: "unrelated drive-by change",
    },
  ],
});
// In real flow, rejected files don't appear in files_changed (merge dropped them).
// But the workbench did edit them; for testing, simulate the realistic case where
// merge-rejected files are not in files_changed.
const caseB2 = makeAttempt({
  files_changed: ["src/foo.ts"],
  target_files: ["src/foo.ts"],
  boundary_violations: ["src/unrelated.ts"],
  escalations: [
    {
      file: "src/unrelated.ts",
      reason: "wanted to also fix this thing I noticed",
      verdict: "rejected",
      judge_score: 0.1,
      judge_rationale: "unrelated drive-by change",
    },
  ],
});
const bundleB = buildRewardBundle(caseB2, DEFAULT_WEIGHTS);
console.log(
  `  B (rejected escalation): reward=${bundleB.reward.toFixed(3)}  sem=${bundleB.semantic_confidence.score.toFixed(3)}  guard=${JSON.stringify(bundleB.guard_flags)}`,
);
check("B: boundary_violation flag still raised", bundleB.guard_flags.includes("boundary_violation"));
check("B: no good judgment bonus (had rejection)", !bundleB.semantic_confidence.evidence.some((e) => e.includes("good judgment")));

// Case C: pure drift (no escalation, agent just went off, different dir)
const caseC = makeAttempt({
  files_changed: ["other/wrong.ts"],
  target_files: ["src/right.ts"],
});
const bundleC = buildRewardBundle(caseC, DEFAULT_WEIGHTS);
console.log(
  `  C (pure drift, no escalate): reward=${bundleC.reward.toFixed(3)}  sem=${bundleC.semantic_confidence.score.toFixed(3)}  guard=${JSON.stringify(bundleC.guard_flags)}`,
);
check("C: goal_drift flag raised", bundleC.guard_flags.includes("goal_drift"));

// Case D: perfect alignment (no escalation needed)
const caseD = makeAttempt({
  files_changed: ["src/foo.ts"],
  target_files: ["src/foo.ts"],
});
const bundleD = buildRewardBundle(caseD, DEFAULT_WEIGHTS);
console.log(
  `  D (perfect, no escalate): reward=${bundleD.reward.toFixed(3)}  sem=${bundleD.semantic_confidence.score.toFixed(3)}  guard=${JSON.stringify(bundleD.guard_flags)}`,
);
check("D: no guard flags", bundleD.guard_flags.length === 0);
check("D: perfect alignment evidence", bundleD.semantic_confidence.evidence.some((e) => e.includes("perfect alignment")));

// Case E: approved escalation should reward HIGHER than rejected (the whole point)
check(
  "A reward > C reward (approved beats drift)",
  bundleA.semantic_confidence.score > bundleC.semantic_confidence.score,
  `A=${bundleA.semantic_confidence.score} vs C=${bundleC.semantic_confidence.score}`,
);
check(
  "A reward > B reward (approved beats rejected)",
  bundleA.semantic_confidence.score > bundleB.semantic_confidence.score,
  `A=${bundleA.semantic_confidence.score} vs B=${bundleB.semantic_confidence.score}`,
);

console.log(`\n━━━ ${pass} passed, ${fail} failed ━━━`);
process.exit(fail === 0 ? 0 : 1);

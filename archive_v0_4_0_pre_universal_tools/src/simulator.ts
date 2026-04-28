import { Attempt, ExperienceKey, StrategyGenome } from "./types";

let attemptCounter = 0;

function jitter(base: number, ratio = 0.3, random = Math.random): number {
  return Math.round(base * (1 + (random() * 2 - 1) * ratio));
}

export function mockAttempt(key: ExperienceKey, genome: StrategyGenome, random = Math.random): Attempt {
  attemptCounter += 1;

  const isTestFirst = genome.validation_strategy.required.includes("write_or_update_targeted_test");
  const isScout = genome.context_strategy.scout_first;
  const tooBroad = genome.action_strategy.patch_granularity === "large" || genome.boundary_strategy.max_diff_lines > 260;

  let result: Attempt["result"] = "success";
  const notes: string[] = [];
  let testsAdded = isTestFirst ? 1 : 0;
  let diffLines = tooBroad ? jitter(310, 0.2, random) : genome.action_strategy.patch_granularity === "tiny" ? jitter(75, 0.3, random) : jitter(145, 0.25, random);
  const boundaryViolations: string[] = [];
  const filesChanged: string[] = ["src/cli/router.ts"];

  if (!isScout && !isTestFirst) {
    result = "failure";
    notes.push("missing context before patch; likely underread");
  }
  if (!isTestFirst && key.goal_pattern === "add_cli_command") {
    result = "failure";
    notes.push("behavior changed without targeted test");
  }
  if (tooBroad) {
    notes.push("patch too broad for current boundary");
    if (random() < 0.4) {
      filesChanged.push("src/cli/utils.ts", "src/cli/types.ts", "src/shared/helpers.ts");
    }
  }
  if (genome.boundary_strategy.allowed_file_policy === "affected_module_only" && key.context_shape.includes("cli_tests")) {
    result = "blocked";
    boundaryViolations.push("tests file required but not allowed");
  }

  // random boundary violation for narrow policies
  if (genome.boundary_strategy.allowed_file_policy === "affected_module_only" && random() < 0.25) {
    boundaryViolations.push("dependency file outside allowed scope");
    if (result === "success") result = "blocked";
  }

  // random semantic miss even on "success"
  if (result === "success" && random() < 0.15) {
    notes.push("tests passed but goal evidence is weak");
  }

  // occasional lucky success for weaker strategies
  if (result === "failure" && random() < 0.1) {
    result = "success";
    notes.push("unexpected pass on retry");
  }

  // reward hacking: weakened assertion — tests pass but assertions are trivial
  if (result === "success" && !genome.action_strategy.forbid_architecture_change && random() < 0.08) {
    notes.push("weakened assertion detected: test passes with trivial expect");
    result = "success";
  }

  // reward hacking: hidden config bypass — skipped validation via config trick
  if (tooBroad && random() < 0.06) {
    notes.push("hidden config bypass: validation skipped via env override");
  }

  if (testsAdded > 0) filesChanged.push("tests/cli.test.ts");

  return {
    id: `attempt_${String(attemptCounter).padStart(4, "0")}`,
    timestamp: new Date().toISOString(),
    experience_key: key,
    strategy_genome_id: genome.id,
    worker: "mock",
    result,
    files_changed: filesChanged,
    diff_lines: diffLines,
    tests_added: testsAdded,
    commands_run: ["npm test -- cli"],
    boundary_violations: boundaryViolations,
    notes,
  };
}

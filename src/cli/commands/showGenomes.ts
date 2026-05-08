import { readJsonl } from "../../storage";
import type { StrategyGenome } from "../../types";

/**
 * Print the contents of a `strategy-genomes.jsonl` file as a table.
 *
 * Each row is flattened into the most useful diagnostic columns (id, parent,
 * generation, status, goal, and a handful of strategy parameters) so the
 * output stays readable in a normal terminal width.
 *
 * If the file is missing or empty, `readJsonl` returns `[]` and an empty
 * table is printed — this lets `antcode show-genomes` work cleanly on a
 * fresh project that has not produced any genomes yet, matching the same
 * "fail-soft" contract used by `showHealth`.
 */
export function showGenomes(genomesFile: string): void {
  const genomes = readJsonl<StrategyGenome>(genomesFile);
  console.table(
    genomes.map((g) => ({
      id: g.id,
      parent: g.parent_id ?? "-",
      gen: g.generation,
      status: g.status,
      goal: g.applies_to.goal_pattern,
      maxFiles: g.context_strategy.max_files,
      patch: g.action_strategy.patch_granularity,
      maxDiff: g.boundary_strategy.max_diff_lines,
    })),
  );
}

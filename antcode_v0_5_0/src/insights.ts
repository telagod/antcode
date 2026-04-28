import { Attempt, RewardBundle } from "./types";
import { antcodePath, tryReadJsonl } from "./storage";


export interface SharedInsight {
  task_goal: string;
  genome_id: string;
  what_worked: string[];
  what_failed: string[];
  files_touched: string[];
}

export function gatherInsights(root: string, goalPattern: string, limit = 5): SharedInsight[] {
  const attempts = tryReadJsonl<Attempt>(antcodePath(root, "attempts.jsonl"), []);
  const rewards = tryReadJsonl<RewardBundle>(antcodePath(root, "reward-bundles.jsonl"), []);

  const rewardMap = new Map(rewards.map((r) => [r.attempt_id, r]));
  const relevant = attempts
    .filter((a) => a.experience_key.goal_pattern === goalPattern)
    .slice(-20);

  const successes: SharedInsight[] = [];
  const failures: SharedInsight[] = [];

  for (const a of relevant) {
    const r = rewardMap.get(a.id);
    if (!r) continue;

    if (a.result === "success") {
      successes.push({
        task_goal: goalPattern,
        genome_id: a.strategy_genome_id,
        what_worked: a.notes.filter((n) => !n.startsWith("tokens:")).slice(0, 3),
        what_failed: [],
        files_touched: a.files_changed,
      });
    } else if (a.result === "failure" || a.result === "blocked") {
      failures.push({
        task_goal: goalPattern,
        genome_id: a.strategy_genome_id,
        what_worked: [],
        what_failed: a.notes.filter((n) => !n.startsWith("tokens:") && (n.includes("error") || n.includes("fail") || n.includes("block") || n.includes("exceed"))).slice(0, 2),
        files_touched: a.files_changed,
      });
    }
  }

  return [...successes.slice(-limit), ...failures.slice(-limit)];
}

export function formatInsightsForPrompt(insights: SharedInsight[]): string {
  if (!insights.length) return "";

  const lines: string[] = ["## Prior Attempts (shared knowledge)"];
  const successes = insights.filter((i) => i.what_worked.length > 0);
  const failures = insights.filter((i) => i.what_failed.length > 0);

  if (successes.length) {
    lines.push("\nSuccessful approaches:");
    for (const s of successes.slice(-3)) {
      lines.push(`- ${s.genome_id}: ${s.what_worked.join("; ")} [files: ${s.files_touched.join(", ")}]`);
    }
  }
  if (failures.length) {
    lines.push("\nApproaches that failed (avoid these):");
    for (const f of failures.slice(-3)) {
      lines.push(`- ${f.genome_id}: ${f.what_failed.join("; ")}`);
    }
  }

  return lines.join("\n");
}

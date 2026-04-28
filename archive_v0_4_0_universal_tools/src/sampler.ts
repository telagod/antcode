import { ExperienceKey, NegativePheromone, StrategyGenome, StrategyPheromone } from "./types";

export function hashExperienceKey(key: ExperienceKey): string {
  return [
    key.goal_pattern,
    key.module_region,
    key.error_pattern ?? "none",
    key.context_shape.join("+"),
    key.risk_level,
  ].join(":");
}

export function scoreGenomeForSampling(
  genome: StrategyGenome,
  keyHash: string,
  positives: StrategyPheromone[],
  negatives: NegativePheromone[],
): number {
  if (genome.status === "quarantined") return 0;
  if (genome.status === "suppressed") return 0.05;

  const pos = positives.find(
    (p) => p.experience_key_hash === keyHash && p.strategy_genome_id === genome.id,
  );
  const negs = negatives.filter(
    (n) => n.experience_key_hash === keyHash && n.strategy_genome_id === genome.id,
  );

  const base = genome.status === "candidate" ? 0.35 : 0.6;
  const positive = pos ? pos.positive * pos.confidence : 0;
  const negativePenalty = negs.reduce((sum, n) => sum + n.penalty * n.confidence, 0);
  return Math.max(0.01, base + positive - negativePenalty);
}

export function sampleGenome(
  genomes: StrategyGenome[],
  key: ExperienceKey,
  positives: StrategyPheromone[],
  negatives: NegativePheromone[],
  random = Math.random,
): StrategyGenome {
  const keyHash = hashExperienceKey(key);

  // exact match
  let candidates = genomes.filter((g) =>
    g.applies_to.goal_pattern === key.goal_pattern &&
    g.applies_to.module_region === key.module_region &&
    g.status !== "quarantined",
  );

  // fuzzy: match goal_pattern only
  if (candidates.length === 0) {
    candidates = genomes.filter((g) =>
      g.applies_to.goal_pattern === key.goal_pattern &&
      g.status !== "quarantined",
    );
  }

  // broadest: any active/candidate genome
  if (candidates.length === 0) {
    candidates = genomes.filter((g) => g.status === "active" || g.status === "candidate");
  }

  if (candidates.length === 0) {
    throw new Error(`No strategy genomes available for ${keyHash}`);
  }

  const scored = candidates.map((g) => ({ g, score: scoreGenomeForSampling(g, keyHash, positives, negatives) }));
  const total = scored.reduce((sum, item) => sum + item.score, 0);
  let cursor = random() * total;
  for (const item of scored) {
    cursor -= item.score;
    if (cursor <= 0) return item.g;
  }
  return scored[scored.length - 1].g;
}

export function samplingTable(
  genomes: StrategyGenome[],
  key: ExperienceKey,
  positives: StrategyPheromone[],
  negatives: NegativePheromone[],
): Array<{ id: string; status: string; score: number; probability: number }> {
  const keyHash = hashExperienceKey(key);
  const rows = genomes
    .filter((g) => g.applies_to.goal_pattern === key.goal_pattern && g.applies_to.module_region === key.module_region)
    .map((g) => ({ id: g.id, status: g.status, score: scoreGenomeForSampling(g, keyHash, positives, negatives) }));
  const total = rows.reduce((s, r) => s + r.score, 0) || 1;
  return rows.map((r) => ({ ...r, probability: r.score / total }));
}

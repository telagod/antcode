import {
  ExperienceKey,
  NegativePheromone,
  StrategyGenome,
  StrategyPheromone,
} from "./types";
import { createEmbeddingClient, LocalFallbackClient } from "./embeddings/client";

/**
 * Creates a deterministic string representation of an ExperienceKey for use as a
 * lookup/join key in pheromone storage and sampling operations.
 *
 * ## Hashing Algorithm
 * This function uses simple field concatenation with colon delimiters rather than
 * a cryptographic hash function. The output format is:
 *   `goal_pattern:module_region:error_pattern:context_shape:risk_level`
 *
 * ## Collision Handling
 * **WARNING: This function does NOT provide collision resistance.**
 * Hash collisions are theoretically possible (e.g., different keys producing identical
 * strings). The system handles this by:
 * - Using the hash only for non-security-critical lookups in pheromone tables
 * - Storing the original ExperienceKey alongside the hash for verification where needed
 * - Relying on database/table uniqueness constraints to prevent duplicate entries
 *
 * ## Security Considerations
 * - **DO NOT use for cryptographic purposes** - This is NOT a secure hash
 * - **DO NOT use for tamper detection or integrity verification**
 * - **DO NOT use in security-sensitive comparisons** - Use constant-time comparison
 *   if comparing two hashes (this function uses simple string concat which is timing-safe
 *   but the underlying string operations may leak information about input lengths)
 * - The function is designed for performance and deterministic mapping in evolutionary
 *   algorithm state management, not security
 * - For any security-sensitive hashing needs, use a proper cryptographic hash like
 *   SHA-256 with HMAC for keyed hashing
 *
 * ## Usage Context
 * This hash is used exclusively for:
 * - Indexing pheromone entries in storage (StrategyPheromone.experience_key_hash)
 * - Joining reward data with experience keys in calculations
 * - Sampling table lookups
 *
 * @param key - The ExperienceKey to hash
 * @returns A deterministic string representation suitable for non-security-critical lookups
 */
export function hashExperienceKey(key: ExperienceKey): string {
  return [
    key.goal_pattern,
    key.module_region,
    key.error_pattern ?? "none",
    key.context_shape.join("+"),
    key.risk_level,
  ].join(":");
}

// ── Beta distribution for Thompson Sampling ──
interface BetaDist {
  alpha: number;
  beta: number;
}

function betaSample({ alpha, beta }: BetaDist, random = Math.random): number {
  // Approximate Beta sampling via Gamma (sufficient for our use case)
  // For small integers we can use a simple approximation
  if (alpha <= 0 || beta <= 0) return 0;
  // Use order statistics approximation for integer-ish alphas/betas
  const a = Math.max(1, Math.round(alpha));
  const b = Math.max(1, Math.round(beta));
  let x = 0;
  for (let i = 0; i < a; i++) x -= Math.log(random());
  let y = 0;
  for (let i = 0; i < b; i++) y -= Math.log(random());
  return x / (x + y);
}

function buildBeta(
  genome: StrategyGenome,
  keyHash: string,
  positives: StrategyPheromone[],
  negatives: NegativePheromone[],
): BetaDist {
  const pos = positives.find(
    (p) => p.experience_key_hash === keyHash && p.strategy_genome_id === genome.id,
  );
  const negs = negatives.filter(
    (n) => n.experience_key_hash === keyHash && n.strategy_genome_id === genome.id,
  );

  // successes = positive count (approximated by positive signal)
  // failures = negative penalties
  // Guard against sample_count being 0 or undefined/null
  const sampleCount = pos?.sample_count ?? 0;
  const successes = pos ? Math.max(1, sampleCount) * pos.positive : 1;
  const failures = negs.reduce((sum, n) => sum + n.penalty * n.confidence, 0) + 1;
  return { alpha: successes + 1, beta: failures + 1 };
}

// ── Evaporation ──
function applyEvaporation(
  negatives: NegativePheromone[],
  evaporationRate: number,
): NegativePheromone[] {
  const now = new Date().toISOString();
  return negatives.map((n) => ({
    ...n,
    penalty: n.penalty * (1 - evaporationRate),
    confidence: n.confidence * (1 - evaporationRate),
    updated_at: now,
  }));
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

// ── UCB1 bonus ──
function ucbBonus(
  genome: StrategyGenome,
  keyHash: string,
  positives: StrategyPheromone[],
  totalSamplesAll: number,
): number {
  const pos = positives.find(
    (p) => p.experience_key_hash === keyHash && p.strategy_genome_id === genome.id,
  );
  // Ensure sample_count is at least 1 to avoid division by zero
  const sampleCount = pos?.sample_count ?? 0;
  const s = pos ? Math.max(1, sampleCount) : 1;
  // exploration bonus: high when few samples, low when many
  return Math.sqrt((2 * Math.log(totalSamplesAll + 1)) / s);
}

export function scoreGenomeUCB(
  genome: StrategyGenome,
  keyHash: string,
  positives: StrategyPheromone[],
  negatives: NegativePheromone[],
  totalSamplesAll: number,
  ucbWeight = 0.3,
): number {
  const exploitation = scoreGenomeForSampling(genome, keyHash, positives, negatives);
  const exploration = ucbBonus(genome, keyHash, positives, totalSamplesAll);
  // Ensure minimum score to avoid zero-probability selection
  return Math.max(0.01, exploitation + ucbWeight * exploration);
}

// ── Thompson Sampling score ──
export function scoreGenomeThompson(
  genome: StrategyGenome,
  keyHash: string,
  positives: StrategyPheromone[],
  negatives: NegativePheromone[],
): number {
  // Use the same status guards as scoreGenomeForSampling for consistency
  if (genome.status === "quarantined") return 0;
  if (genome.status === "suppressed") return 0.05;
  const beta = buildBeta(genome, keyHash, positives, negatives);
  // betaSample can return 0 for extreme distributions, ensure minimum score
  return Math.max(0.01, betaSample(beta));
}


// ── Embedding-based fuzzy matching ──
let _embeddingClient: LocalFallbackClient | undefined;

function getEmbeddingClient(): LocalFallbackClient {
  if (!_embeddingClient) _embeddingClient = new LocalFallbackClient();
  return _embeddingClient;
}

function keyToText(key: ExperienceKey): string {
  return `${key.goal_pattern} ${key.module_region} ${key.error_pattern ?? ""} ${key.context_shape.join(" ")} ${key.risk_level}`;
}

export function findByEmbeddingSimilarity(
  genomes: StrategyGenome[],
  key: ExperienceKey,
  threshold = 0.8,
): StrategyGenome | undefined {
  try {
    const client = getEmbeddingClient();
    const targetText = keyToText(key);
    let best: StrategyGenome | undefined;
    let bestScore = -1;
    for (const g of genomes) {
      if (g.status === "quarantined" || g.status === "suppressed") continue;
      const a = g.applies_to as any;
      const genomeText = `${a.goal_pattern ?? ""} ${a.module_region ?? ""} ${a.error_pattern ?? ""} ${(a.context_shape ?? []).join(" ")} ${a.risk_level ?? ""}`;
      const score = client.similarity(targetText, genomeText);
      if (score > threshold && score > bestScore) {
        best = g;
        bestScore = score;
      }
    }
    return best;
  } catch (error) {
    // Embedding service unavailable or other error - log and return undefined to fall through
    // to broader sampling strategies (any active/candidate genome)
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[findByEmbeddingSimilarity] Embedding service error: ${message}`);
    return undefined;
  }
}

export function sampleGenome(
  genomes: StrategyGenome[],
  key: ExperienceKey,
  positives: StrategyPheromone[],
  negatives: NegativePheromone[],
  random = Math.random,
  useUCB = false,
  useThompson = false,
  totalSamplesAll = 0,
): StrategyGenome {
  const keyHash = hashExperienceKey(key);

  // Evaporate negatives once per sampling round (lightweight)
  negatives = applyEvaporation(negatives, 0.02);

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

  // semantic: embedding similarity > 0.8
  if (candidates.length === 0) {
    const sim = findByEmbeddingSimilarity(genomes, key, 0.8);
    if (sim) candidates = [sim];
  }

  // last resort: any active/candidate genome — but ONLY if its action_strategy is conservative
  // (small/tiny granularity, prefer_existing_pattern). Avoid pulling in big-bang or scout-narrow
  // genomes that are tuned for unrelated goal_patterns and end up exploring without editing.
  if (candidates.length === 0) {
    candidates = genomes.filter((g) =>
      (g.status === "active" || g.status === "candidate") &&
      (g.action_strategy.patch_granularity === "tiny" || g.action_strategy.patch_granularity === "small") &&
      g.action_strategy.prefer_existing_pattern === true,
    );
  }

  // absolute last resort: any active genome (prevents total starvation)
  if (candidates.length === 0) {
    candidates = genomes.filter((g) => g.status === "active" || g.status === "candidate");
  }

  if (candidates.length === 0) {
    throw new Error(`No strategy genomes available for ${keyHash}`);
  }

  const scored = candidates.map((g) => {
    let score: number;
    if (useThompson) {
      score = scoreGenomeThompson(g, keyHash, positives, negatives);
    } else if (useUCB) {
      score = scoreGenomeUCB(g, keyHash, positives, negatives, totalSamplesAll);
    } else {
      score = scoreGenomeForSampling(g, keyHash, positives, negatives);
    }
    return { g, score };
  });

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

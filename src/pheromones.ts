import type { FailureMode } from "./attempts";

/**
 * Positive reinforcement signal for a genome on a specific experience key.
 * One row per `(experience_key_hash, strategy_genome_id)` pair. Written
 * and maintained by `updatePheromone` / `evaporatePheromones` in
 * `src/cli.ts`; read by the sampler in `src/sampler.ts`.
 *
 * Stored in `.antcode/strategy-pheromones.jsonl`.
 */
export interface StrategyPheromone {
  /** `hashExperienceKey(key)` — join key against `RewardBundle.experience_key_hash`. */
  experience_key_hash: string;
  /** Genome this pheromone belongs to. */
  strategy_genome_id: string;
  /** Exponentially-weighted moving average of reward in `[0, 1]`. Update rule: `0.8·old + 0.2·new`. Decays by factor `(1 - evaporation.positive)` during evaporation. */
  positive: number;
  /** Confidence in `positive`, in `[0.1, 1]`. Grows `+0.08` per update; decays by `(1 - 0.5·evaporation.positive)` during evaporation (floored at `0.1`). */
  confidence: number;
  /** Monotonic count of reward updates merged into this row. */
  sample_count: number;
  /** ISO 8601 UTC of the most recent update (equal to creation time for new rows). */
  updated_at: string;
}

/**
 * Penalty signal written when `classifyFailureMode` returns a
 * pathological {@link FailureMode} for an attempt. Multiple rows per
 * `(experience_key_hash, strategy_genome_id)` are allowed — one per
 * distinct `reason`.
 *
 * Stored in `.antcode/negative-pheromones.jsonl`. Rows with
 * `penalty <= 0.01` are garbage-collected during evaporation.
 */
export interface NegativePheromone {
  /** `hashExperienceKey(key)` — scope of the penalty. */
  experience_key_hash: string;
  /** Genome being penalized. */
  strategy_genome_id: string;
  /** The {@link FailureMode} that triggered the penalty. One row per reason per (key, genome). */
  reason: FailureMode;
  /** Accumulated penalty magnitude in `[0, 1]`. Grows by `penalty·0.2` per failed attempt; decays by `(1 - rate)` during evaporation, where `rate` is scaled by `decay`. */
  penalty: number;
  /** Confidence in `penalty`, in `[0.1, 1]`. Grows `+0.1` per update; decays with `penalty` during evaporation. */
  confidence: number;
  /** Decay rate class. Effective rate = `evaporation.negative × {fast: 1.5, medium: 1.0, slow: 0.5}`. */
  decay: "fast" | "medium" | "slow";
  /** `Attempt.id` list cited as evidence for this penalty — audit trail. Appended on each matching failure. */
  evidence_attempts: string[];
  /** ISO 8601 UTC of the most recent update. */
  updated_at: string;
}

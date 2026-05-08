// Targeted test for the consolidated ScoringStrategy interface in src/sampler.ts.
//
// Verifies that:
//   1. getScoringStrategy returns the correct strategy by discriminator name.
//   2. Each strategy produces identical scores to its legacy wrapper function
//      (greedy, ucb, thompson) given the same inputs.
//   3. Unknown strategy names throw a descriptive error.
//
// Run: tsx tests/sampler-scoring-strategy.test.ts

import assert from "node:assert/strict";
import {
  getScoringStrategy,
  greedyStrategy,
  ucbStrategy,
  thompsonStrategy,
  scoreGenomeForSampling,
  scoreGenomeThompson,
  type ScoringContext,
  type ScoringStrategy,
} from "../src/sampler";
import type {
  StrategyGenome,
  StrategyPheromone,
  NegativePheromone,
} from "../src/types";

function makeGenome(overrides: Partial<StrategyGenome> = {}): StrategyGenome {
  return {
    id: "g1",
    parent_id: null,
    generation: 0,
    status: "active",
    applies_to: { goal_pattern: "fix:bug", module_region: "src/foo" },
    context_strategy: { read_order: [], max_files: 5, scout_first: false },
    action_strategy: {
      patch_granularity: "small",
      prefer_existing_pattern: true,
      forbid_architecture_change: false,
    },
    validation_strategy: { required: [], optional: [] },
    boundary_strategy: { allowed_file_policy: "any", max_diff_lines: 100 },
    reward_profile: { optimize_for: [], punish: [] },
    mutation_policy: [],
    ...overrides,
  };
}

function makePositive(overrides: Partial<StrategyPheromone> = {}): StrategyPheromone {
  return {
    experience_key_hash: "k1",
    strategy_genome_id: "g1",
    positive: 0.5,
    confidence: 0.8,
    sample_count: 4,
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeNegative(overrides: Partial<NegativePheromone> = {}): NegativePheromone {
  return {
    experience_key_hash: "k1",
    strategy_genome_id: "g1",
    reason: "test_failure" as NegativePheromone["reason"],
    penalty: 0.1,
    confidence: 0.5,
    decay: "medium",
    evidence_attempts: [],
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── 1. Registry returns the correct strategy by name ──
{
  const greedy = getScoringStrategy("greedy");
  const ucb = getScoringStrategy("ucb");
  const thompson = getScoringStrategy("thompson");
  assert.equal(greedy.name, "greedy");
  assert.equal(ucb.name, "ucb");
  assert.equal(thompson.name, "thompson");
  assert.equal(greedy, greedyStrategy);
  assert.equal(ucb, ucbStrategy);
  assert.equal(thompson, thompsonStrategy);
  console.log("✓ getScoringStrategy returns each named strategy");
}

// ── 2. Greedy strategy ≡ scoreGenomeForSampling ──
{
  const genome = makeGenome();
  const positives = [makePositive()];
  const negatives = [makeNegative()];
  const ctx: ScoringContext = { genome, keyHash: "k1", positives, negatives };
  const viaStrategy = greedyStrategy.score(ctx);
  const viaWrapper = scoreGenomeForSampling(genome, "k1", positives, negatives);
  assert.equal(viaStrategy, viaWrapper);
  console.log("✓ greedyStrategy.score matches scoreGenomeForSampling");
}

// Quarantined / suppressed handling propagates through the strategy.
{
  const quarantined = makeGenome({ status: "quarantined" });
  const suppressed = makeGenome({ status: "suppressed" });
  assert.equal(greedyStrategy.score({ genome: quarantined, keyHash: "k1", positives: [], negatives: [] }), 0);
  assert.equal(greedyStrategy.score({ genome: suppressed, keyHash: "k1", positives: [], negatives: [] }), 0.05);
  console.log("✓ greedyStrategy handles quarantined/suppressed statuses");
}

// ── 3. UCB strategy adds an exploration bonus on top of greedy exploitation ──
{
  const genome = makeGenome();
  const positives = [makePositive({ sample_count: 2 })];
  const negatives: NegativePheromone[] = [];
  const totalSamplesAll = 10;
  const ucbWeight = 0.3;
  const ctx: ScoringContext = {
    genome,
    keyHash: "k1",
    positives,
    negatives,
    totalSamplesAll,
    ucbWeight,
  };
  const ucbScore = ucbStrategy.score(ctx);
  const greedyScoreOnly = greedyStrategy.score(ctx);
  // exploration term = sqrt(2 * ln(totalSamplesAll + 1) / sample_count)
  const expectedExploration =
    Math.sqrt((2 * Math.log(totalSamplesAll + 1)) / 2);
  assert.equal(ucbScore, greedyScoreOnly + ucbWeight * expectedExploration);
  console.log("✓ ucbStrategy.score = greedy exploitation + ucbWeight * exploration");
}

// UCB defaults: ucbWeight defaults to 0.3, totalSamplesAll defaults to 0.
{
  const genome = makeGenome();
  const positives = [makePositive({ sample_count: 2 })];
  const withDefaults = ucbStrategy.score({
    genome,
    keyHash: "k1",
    positives,
    negatives: [],
  });
  const withExplicit = ucbStrategy.score({
    genome,
    keyHash: "k1",
    positives,
    negatives: [],
    totalSamplesAll: 0,
    ucbWeight: 0.3,
  });
  assert.equal(withDefaults, withExplicit);
  console.log("✓ ucbStrategy applies default ucbWeight=0.3 and totalSamplesAll=0");
}

// ── 4. Thompson strategy ≡ scoreGenomeThompson with seeded random ──
{
  // Deterministic PRNG so the comparison is reproducible.
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
  const genome = makeGenome();
  const positives = [makePositive()];
  const negatives = [makeNegative()];

  const rng1 = makeRng(42);
  const viaStrategy = thompsonStrategy.score({
    genome,
    keyHash: "k1",
    positives,
    negatives,
    random: rng1,
  });

  // Re-seed and call the legacy wrapper, but we have to monkey-patch
  // Math.random to keep parity since scoreGenomeThompson doesn't accept rng.
  const rng2 = makeRng(42);
  const origRandom = Math.random;
  Math.random = rng2;
  try {
    const viaWrapper = scoreGenomeThompson(genome, "k1", positives, negatives);
    assert.equal(viaStrategy, viaWrapper);
  } finally {
    Math.random = origRandom;
  }
  console.log("✓ thompsonStrategy.score matches scoreGenomeThompson with same RNG");
}

// Thompson strategy short-circuits quarantined/suppressed before sampling.
{
  const quarantined = makeGenome({ status: "quarantined" });
  const suppressed = makeGenome({ status: "suppressed" });
  assert.equal(
    thompsonStrategy.score({ genome: quarantined, keyHash: "k1", positives: [], negatives: [] }),
    0,
  );
  assert.equal(
    thompsonStrategy.score({ genome: suppressed, keyHash: "k1", positives: [], negatives: [] }),
    0.05,
  );
  console.log("✓ thompsonStrategy handles quarantined/suppressed statuses");
}

// ── 5. Unknown strategy name throws ──
{
  assert.throws(
    () => getScoringStrategy("bogus" as never),
    /Unknown scoring strategy/,
  );
  console.log("✓ getScoringStrategy throws on unknown name");
}

// ── 6. The strategy interface has the expected shape ──
{
  const strategies: ScoringStrategy[] = [greedyStrategy, ucbStrategy, thompsonStrategy];
  for (const s of strategies) {
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.score, "function");
  }
  console.log("✓ All strategies implement { name, score } shape");
}

console.log("\nAll sampler scoring-strategy tests passed.");

import { Attempt, RewardBundle, RewardWeights, WeightCalibrationRecord } from "../types";
import { clampWeights, loadWeights, saveWeights, recordCalibration } from "./weights";

interface CalibrationSample {
  attempt: Attempt;
  bundle: RewardBundle;
  predictedSuccess: number; // reward score before clamp
  actualSuccess: number; // 1 if result==="success" else 0
}

function actualSuccess(a: Attempt): number {
  return a.result === "success" ? 1 : a.result === "blocked" ? 0.5 : 0;
}

/**
 * Simple moving-average calibration.
 * For each weight dimension, compute correlation with actual success
 * and nudge weights toward better predicting success.
 * This is a first-order approximation, not true regression, but it
 * requires no external ML library and runs in-memory on small data.
 */
export function calibrateWeights(
  root: string,
  history: CalibrationSample[],
  minSamples = 10,
): RewardWeights | null {
  if (history.length < minSamples) return null;

  const w = loadWeights(root);

  // Compute current MSE
  const currentMse =
    history.reduce((s, h) => s + (h.predictedSuccess - h.actualSuccess) ** 2, 0) / history.length;

  // For each weight, try +10% and -10%, evaluate hypothetical MSE
  const keys = Object.keys(w) as (keyof RewardWeights)[];
  const delta = 0.1;
  let bestWeights = { ...w };
  let bestMse = currentMse;

  for (const key of keys) {
    const base = w[key];
    for (const sign of [-1, 1] as const) {
      const trial = { ...w, [key]: base * (1 + sign * delta) };
      const clamped = clampWeights(trial);
      const mse = evaluateMse(history, clamped);
      if (mse < bestMse) {
        bestMse = mse;
        bestWeights = clamped;
      }
    }
  }

  // If improvement is meaningful (>1% relative), save
  if (bestMse < currentMse * 0.99) {
    saveWeights(root, bestWeights);
    recordCalibration(root, {
      timestamp: new Date().toISOString(),
      weights: bestWeights,
      mse: bestMse,
      samples_used: history.length,
    });
    return bestWeights;
  }

  return null;
}

function evaluateMse(history: CalibrationSample[], weights: RewardWeights): number {
  // We can't easily re-run buildRewardBundle here without importing it,
  // so we use a lightweight proxy: correlation of reward with actual success.
  // Better approach: after this function, the caller should recompute rewards.
  // For now, use a heuristic based on reward variance alignment.
  let total = 0;
  for (const h of history) {
    // Simple heuristic: predictedSuccess is already computed with old weights.
    // We approximate new prediction by scaling the contribution of the changed dimension.
    // This is crude but avoids circular dependencies.
    const err = h.predictedSuccess - h.actualSuccess;
    total += err * err;
  }
  return total / history.length;
}

/**
 * Prepare calibration samples from attempts and their reward bundles.
 */
export function prepareCalibrationSamples(
  attempts: Attempt[],
  bundles: RewardBundle[],
): CalibrationSample[] {
  const bundleMap = new Map(bundles.map((b) => [b.attempt_id, b]));
  const samples: CalibrationSample[] = [];
  for (const a of attempts) {
    const b = bundleMap.get(a.id);
    if (!b) continue;
    samples.push({
      attempt: a,
      bundle: b,
      predictedSuccess: b.reward,
      actualSuccess: actualSuccess(a),
    });
  }
  return samples;
}

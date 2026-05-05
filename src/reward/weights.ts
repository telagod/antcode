import { RewardWeights, WeightCalibrationRecord } from "../types";
export type { RewardWeights, WeightCalibrationRecord } from "../types";
import { readJson, writeJson, tryReadJson } from "../storage";
import path from "node:path";

let _cachedWeights: RewardWeights | null = null;
let _cachedRoot: string | null = null;

export const DEFAULT_WEIGHTS: RewardWeights = {
  success_base_success: 0.7,
  success_base_blocked: 0.2,
  success_base_failure: 0.35,
  semantic_weight: 0.25,
  diff_penalty_coeff: 1000,
  file_penalty_coeff: 20,
  guard_penalty_coeff: 0.2,
  token_penalty_coeff: 50000,
  cache_bonus_coeff: 0.05,
  test_bonus: 0.12,
  test_execution_bonus: 0.08,
  boundary_bonus: 0.05,
  reward_hacking_penalty: 0.55,
};

function weightsPath(root: string): string {
  return path.join(root, ".antcode", "reward-weights.json");
}

function calibrationPath(root: string): string {
  return path.join(root, ".antcode", "weight-calibration-history.json");
}

export function loadWeights(root: string): RewardWeights {
  if (_cachedWeights && _cachedRoot === root) return _cachedWeights;
  const { value } = tryReadJson<RewardWeights>(weightsPath(root), DEFAULT_WEIGHTS);
  _cachedWeights = value;
  _cachedRoot = root;
  return value;
}

export function saveWeights(root: string, weights: RewardWeights): void {
  writeJson(weightsPath(root), weights);
  _cachedWeights = weights;
  _cachedRoot = root;
}

export function resetWeights(root: string): void {
  saveWeights(root, DEFAULT_WEIGHTS);
}

export function recordCalibration(root: string, record: WeightCalibrationRecord): void {
  const file = calibrationPath(root);
  const history = tryReadJson<WeightCalibrationRecord[]>(file, []).value;
  history.push(record);
  // keep last 20 records
  if (history.length > 20) history.splice(0, history.length - 20);
  writeJson(file, history);
}

export function getCalibrationHistory(root: string): WeightCalibrationRecord[] {
  return tryReadJson<WeightCalibrationRecord[]>(calibrationPath(root), []).value;
}

export function clampWeights(w: Partial<RewardWeights>): RewardWeights {
  const d = DEFAULT_WEIGHTS;
  function c(v: number | undefined, lo: number, hi: number, def: number): number {
    if (v === undefined || Number.isNaN(v)) return def;
    return Math.max(lo, Math.min(hi, v));
  }
  return {
    success_base_success: c(w.success_base_success, 0, 1, d.success_base_success),
    success_base_blocked: c(w.success_base_blocked, 0, 1, d.success_base_blocked),
    success_base_failure: c(w.success_base_failure, 0, 1, d.success_base_failure),
    semantic_weight: c(w.semantic_weight, 0, 1, d.semantic_weight),
    diff_penalty_coeff: c(w.diff_penalty_coeff, 100, 10000, d.diff_penalty_coeff),
    file_penalty_coeff: c(w.file_penalty_coeff, 5, 100, d.file_penalty_coeff),
    guard_penalty_coeff: c(w.guard_penalty_coeff, 0.05, 1, d.guard_penalty_coeff),
    token_penalty_coeff: c(w.token_penalty_coeff, 10000, 200000, d.token_penalty_coeff),
    cache_bonus_coeff: c(w.cache_bonus_coeff, 0, 0.5, d.cache_bonus_coeff),
    test_bonus: c(w.test_bonus, 0, 0.5, d.test_bonus),
    test_execution_bonus: c(w.test_execution_bonus, 0, 0.5, d.test_execution_bonus),
    boundary_bonus: c(w.boundary_bonus, 0, 0.5, d.boundary_bonus),
    reward_hacking_penalty: c(w.reward_hacking_penalty, 0.1, 1, d.reward_hacking_penalty),
  };
}

// Stable public import path for the reward subsystem.
//
// All implementation lives in ./reward/calculator (and sibling modules under ./reward/).
// This file exists so external consumers can `import { ... } from "antcode/reward"`
// (or relative `./reward`) without depending on the internal layout of the reward/
// directory. The barrel re-export below mirrors every public symbol from the
// calculator module — currently `detectGuardFlags`, `computeAlignment`, and
// `buildRewardBundle` — so adding a new export there automatically surfaces it here.
//
// Note: src/index.ts also re-exports `buildRewardBundle` and `detectGuardFlags`
// directly from ./reward/calculator, so most internal call sites should prefer
// the package root. Keep this shim narrow and side-effect free.
export * from "./reward/calculator";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mockAttempt } from "./index.ts";
import { captureBaseline } from "./verify.ts";
import { ExperienceKey, StrategyGenome } from "./types.ts";

const key: ExperienceKey = {
  goal_pattern: "add_cli_command",
  module_region: "storage",
  context_shape: ["cli_tests"],
  risk_level: "low",
};

const genome: StrategyGenome = {
  id: "g1",
  parent_id: null,
  generation: 1,
  status: "active",
  applies_to: {
    goal_pattern: "add_cli_command",
    module_region: "storage",
    risk_level: "low",
  },
  context_strategy: {
    read_order: ["src/storage.ts"],
    max_files: 3,
    scout_first: true,
  },
  action_strategy: {
    patch_granularity: "small",
    prefer_existing_pattern: false,
    forbid_architecture_change: false,
  },
  validation_strategy: {
    required: ["write_or_update_targeted_test"],
    optional: [],
  },
  boundary_strategy: {
    allowed_file_policy: "workspace",
    max_diff_lines: 120,
  },
  reward_profile: {
    weights: {
      success: 1,
      semantic: 1,
      latency: 1,
      cost: 1,
      risk: 1,
    },
    penalties: {
      boundary_violation: 1,
      repeated_failure: 1,
      reward_hacking: 1,
    },
  },
};

test("captureBaseline surfaces actionable slot context for missing directories", () => {
  const missingSlot = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "verify-missing-slot-")),
    "missing-slot"
  );

  assert.throws(
    () => captureBaseline(missingSlot),
    (error: unknown) => {
      assert.match(String(error), new RegExp(`Failed to capture baseline for slot ${missingSlot}: slot directory: directory does not exist at`));
      return true;
    }
  );
});


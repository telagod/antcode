import { tryReadJsonl } from "../../storage";
import type { ExperienceKeyHealth } from "../../types";

/**
 * Print the contents of an `experience-key-health.jsonl` file as a table.
 *
 * The diagnosis/action arrays are joined into comma-separated strings so the
 * console.table output stays on a single row per entry. If the file is
 * missing or unreadable, an empty table is printed instead of throwing — this
 * lets `antcode show-health` work cleanly on a fresh project that has not
 * produced any health rows yet.
 */
export function showHealth(healthFile: string): void {
  const { value: rows } = tryReadJsonl<ExperienceKeyHealth>(healthFile, []);
  console.table(
    rows.map((h) => ({
      experience_key_hash: h.experience_key_hash,
      sample_count: h.sample_count,
      transfer_success_rate: h.transfer_success_rate,
      strategy_convergence: h.strategy_convergence,
      reward_variance: h.reward_variance,
      contradiction_count: h.contradiction_count,
      diagnosis: (h.diagnosis ?? []).join(", "),
      action: (h.action ?? []).join(", "),
    })),
  );
}

/**
 * Per-patch on-disk manifest written by `createPatchArtifact` in
 * `src/verify.ts`. Stored at
 * `.antcode/artifacts/<id>/manifest.json`.
 *
 * Represents the reviewable patch lifecycle:
 * `created` → `pending_review` → (`merged` | `rejected` | `rolled_back`).
 * Each transition sets the corresponding `*_at` timestamp.
 */
export interface PatchArtifactManifest {
  /** Safe filename derived from `attempt_id`; used as the directory name under `.antcode/artifacts/`. */
  id: string;
  /** Foreign key to `Attempt.id` that produced this patch. */
  attempt_id: string;
  /** ISO 8601 UTC creation time. */
  created_at: string;
  /** ISO 8601 UTC time the patch was approved (moved to `status: "merged"`). Absent until approval. */
  approved_at?: string;
  /** ISO 8601 UTC time the patch was rejected. Absent unless `status === "rejected"`. */
  rejected_at?: string;
  /** ISO 8601 UTC time the patch was rolled back. Absent unless `status === "rolled_back"`. */
  rolled_back_at?: string;
  /** Snapshot of the Attempt's `files_changed` at artifact-creation time. */
  files_changed: string[];
  /** Snapshot of the Attempt's `diff_lines` at artifact-creation time. */
  diff_lines: number;
  /** Project-relative path to the unified diff file (`patch.diff` inside the artifact directory). */
  patch_file: string;
  /** Project-relative path to a directory containing full copies of every changed file at patch time. */
  files_dir: string;
  /** Project-relative path to the verification output log. */
  verification_log: string;
  /** Project-relative path to a backup of the pre-patch files. Created at approval time; consumed by rollback. */
  backup_dir?: string;
  /** Current lifecycle state. */
  status: "pending_review" | "merged" | "rejected" | "rolled_back";
  /** Free-form notes appended across lifecycle transitions. */
  notes: string[];
}

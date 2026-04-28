import crypto from "node:crypto";

export function cacheKeyForTask(taskDesc: string): string {
  return `antcode_${crypto.createHash("sha256").update(taskDesc).digest("hex").slice(0, 24)}`;
}

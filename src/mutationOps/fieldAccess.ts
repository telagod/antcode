/**
 * Path-based field access helpers used by mutation rules and random
 * exploration. These helpers traverse a nested object via a dot-separated
 * path (e.g. `"context_strategy.max_files"`) with built-in protection
 * against prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
 *
 * Extracted from `../mutationOps.ts` so the field-access plumbing can be
 * consumed independently of the mutation rule interpreter and recipe data.
 * The public surface is re-exported from `../mutationOps.ts` to preserve
 * the existing API used by `src/index.ts`.
 */

/**
 * Keys that must never be traversed or written, since they would mutate the
 * prototype chain and enable prototype pollution attacks.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validates a dot-separated path string and returns the segments.
 * Throws an error if the path is empty, contains empty segments, or contains
 * forbidden keys that would enable prototype pollution.
 *
 * @param path - A dot-separated path like "a.b.c"
 * @returns Array of path segments
 * @throws Error if path is empty, contains empty segments (e.g., "a..b", ".b", "a."),
 *   or contains forbidden keys (`__proto__`, `constructor`, `prototype`).
 */
function validatePath(path: string): string[] {
  if (!path || typeof path !== "string") {
    throw new Error(`Invalid path: must be a non-empty string, got ${JSON.stringify(path)}`);
  }
  const segments = path.split(".");
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === "") {
      throw new Error(`Invalid path "${path}": empty segment at position ${i}. Paths must not contain consecutive dots or leading/trailing dots.`);
    }
    if (FORBIDDEN_KEYS.has(segments[i])) {
      throw new Error(`Invalid path "${path}": forbidden key "${segments[i]}" at position ${i} (potential prototype pollution).`);
    }
  }
  return segments;
}

/**
 * Type guard to check if a value is a non-null object suitable for property access.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Discriminated result for {@link tryGetField}.
 *
 * - `{ status: "found", value }` - path resolved and field exists with the given value
 * - `{ status: "absent", at }` - path was valid but a segment was missing on the
 *   final container (caller can distinguish "field not present" from invalid path)
 * - `{ status: "invalid_path", reason }` - path itself is malformed (empty,
 *   has empty segments, contains forbidden prototype-pollution keys)
 * - `{ status: "not_object", at }` - traversal hit a non-object intermediate
 *   value at segment `at` so the deeper path could not be resolved
 */
export type GetFieldResult<T> =
  | { status: "found"; value: T }
  | { status: "absent"; at: string }
  | { status: "invalid_path"; reason: string }
  | { status: "not_object"; at: string };

/**
 * Discriminated result for {@link trySetField}.
 *
 * - `{ status: "ok" }` - the value was written
 * - `{ status: "invalid_path", reason }` - path itself is malformed
 * - `{ status: "not_object", at }` - an intermediate (or terminal) container
 *   along the path was not an object, so the write was refused
 */
export type SetFieldResult =
  | { status: "ok" }
  | { status: "invalid_path"; reason: string }
  | { status: "not_object"; at: string };

export function getField<T>(obj: unknown, path: string): T | undefined {
  const keys = validatePath(path);
  let current: unknown = obj;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current as T;
}

export function setField(obj: unknown, path: string, value: unknown): void {
  const keys = validatePath(path);
  if (keys.length === 0) {
    throw new Error(`Invalid path "${path}": path must have at least one segment`);
  }
  const last = keys.pop()!;
  let current: unknown = obj;
  for (const key of keys) {
    if (!isObject(current)) {
      throw new Error(`Invalid path "${path}": cannot navigate into non-object value at segment "${key}"`);
    }
    current = current[key];
  }
  if (!isObject(current)) {
    throw new Error(`Invalid path "${path}": cannot set property on non-object value at segment "${last}"`);
  }
  current[last] = value;
}

/**
 * Non-throwing variant of {@link getField} that returns a discriminated
 * {@link GetFieldResult}. Lets callers tell the difference between:
 *  - a field that exists (`status: "found"`)
 *  - a field that is genuinely missing (`status: "absent"`)
 *  - a path that is malformed (`status: "invalid_path"`)
 *  - traversal that ran into a non-object intermediate (`status: "not_object"`)
 *
 * Forbidden keys (`__proto__`, `constructor`, `prototype`) yield `invalid_path`
 * rather than silently traversing into the prototype chain.
 */
export function tryGetField<T>(obj: unknown, path: string): GetFieldResult<T> {
  let keys: string[];
  try {
    keys = validatePath(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "invalid_path", reason };
  }

  let current: unknown = obj;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!isObject(current)) {
      return { status: "not_object", at: keys.slice(0, i).join(".") || "<root>" };
    }
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      return { status: "absent", at: keys.slice(0, i + 1).join(".") };
    }
    current = current[key];
  }
  return { status: "found", value: current as T };
}

/**
 * Non-throwing variant of {@link setField} that returns a discriminated
 * {@link SetFieldResult}. Refuses to write through forbidden keys
 * (`__proto__`, `constructor`, `prototype`) or through non-object
 * intermediate values.
 */
export function trySetField(obj: unknown, path: string, value: unknown): SetFieldResult {
  let keys: string[];
  try {
    keys = validatePath(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "invalid_path", reason };
  }
  if (keys.length === 0) {
    return { status: "invalid_path", reason: `Invalid path "${path}": path must have at least one segment` };
  }

  const last = keys[keys.length - 1];
  const parents = keys.slice(0, -1);
  let current: unknown = obj;
  for (let i = 0; i < parents.length; i++) {
    if (!isObject(current)) {
      return { status: "not_object", at: parents.slice(0, i).join(".") || "<root>" };
    }
    current = current[parents[i]];
  }
  if (!isObject(current)) {
    return { status: "not_object", at: parents.join(".") || "<root>" };
  }
  current[last] = value;
  return { status: "ok" };
}

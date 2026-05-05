import fs from "node:fs";
import path from "node:path";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }

  return false;
}

export type StorageErrorCode =
  | "READ_FAILED"
  | "PARSE_FAILED"
  | "WRITE_PREPARE_FAILED"
  | "SERIALIZE_FAILED"
  | "WRITE_FAILED";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly file: string;
  readonly operation: "readJson" | "readJsonl" | "appendJsonl" | "overwriteJsonl" | "writeJson";
  readonly cause?: unknown;
  readonly line?: number;
  readonly partial?: boolean;

  constructor(options: {
    message: string;
    code: StorageErrorCode;
    file: string;
    operation: "readJson" | "readJsonl" | "appendJsonl" | "overwriteJsonl" | "writeJson";
    cause?: unknown;
    line?: number;
    partial?: boolean;
  }) {
    super(options.message);
    this.name = "StorageError";
    this.code = options.code;
    this.file = options.file;
    this.operation = options.operation;
    this.cause = options.cause;
    this.line = options.line;
    this.partial = options.partial;
  }
}

export interface ReadJsonResult<T> {
  value: T;
  found: boolean;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function tryReadJson<T>(file: string, fallback: T): ReadJsonResult<T> {
  try {
    return { value: readJson(file, fallback), found: fs.existsSync(file) };
  } catch (error) {
    if (error instanceof StorageError && (error.code === "PARSE_FAILED" || error.code === "READ_FAILED")) {
      const nodeError = error.cause as NodeJS.ErrnoException | undefined;
      const fileExists =
        error.code === "READ_FAILED" && nodeError?.code === "ENOENT"
          ? false
          : fs.existsSync(file);
      return { value: fallback, found: fileExists };
    }
    throw error;
  }
}

export function readJson<T>(file: string, fallback: T): T {
  let content: string;

  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError && nodeError.code === "ENOENT") {
      return fallback;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "READ_FAILED",
      file,
      operation: "readJson",
      cause: error,
      message: `Failed to read JSON from ${file}: ${message}`,
    });
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (!isJsonValue(parsed)) {
      throw new Error("parsed value is not valid JSON data");
    }
    return parsed as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "PARSE_FAILED",
      file,
      operation: "readJson",
      cause: error,
      message: `Failed to parse JSON from ${file}: file exists but contains malformed JSON. ${message}`,
    });
  }
}
export function writeJson(file: string, value: unknown): void {
  try {
    ensureDir(path.dirname(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "WRITE_PREPARE_FAILED",
      file,
      operation: "writeJson",
      cause: error,
      message: `Failed to prepare directory for JSON write to ${file}: ${message}`,
    });
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2) + "\n";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "SERIALIZE_FAILED",
      file,
      operation: "writeJson",
      cause: error,
      message: `Failed to serialize JSON for ${file}: ${message}`,
    });
  }

  try {
    fs.writeFileSync(file, serialized, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "WRITE_FAILED",
      file,
      operation: "writeJson",
      cause: error,
      message: `Failed to write JSON to ${file}: write did not complete successfully. ${message}`,
    });
  }
}

export function tryReadJsonl<T>(file: string, fallback: T[]): ReadJsonResult<T[]> {
  try {
    return { value: readJsonl<T>(file), found: fs.existsSync(file) };
  } catch (error) {
    if (error instanceof StorageError && (error.code === "PARSE_FAILED" || error.code === "READ_FAILED")) {
      const nodeError = error.cause as NodeJS.ErrnoException | undefined;
      const fileExists =
        error.code === "READ_FAILED" && nodeError?.code === "ENOENT"
          ? false
          : fs.existsSync(file);
      return { value: fallback, found: fileExists };
    }
    throw error;
  }
}

export function readJsonl<T>(file: string): T[] {
  let content: string;

  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError && nodeError.code === "ENOENT") {
      return [];
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "READ_FAILED",
      file,
      operation: "readJsonl",
      cause: error,
      message: `Failed to read JSONL from ${file}: ${message}`,
    });
  }

  const values: T[] = [];
  const rawLines = content.split(/\r?\n/);

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);
      if (!isJsonValue(parsed)) {
        throw new Error("parsed value is not valid JSON data");
      }
      values.push(parsed as T);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isLastLine = index === rawLines.length - 1;
      const hasTrailingNewline = content.endsWith("\n") || content.endsWith("\r");
      const partial = isLastLine && !hasTrailingNewline;
      const partialHint = partial ? " The final line may be partial or truncated." : "";
      throw new StorageError({
        code: "PARSE_FAILED",
        file,
        operation: "readJsonl",
        cause: error,
        line: index + 1,
        partial,
        message: `Failed to parse JSONL from ${file} at line ${index + 1}: malformed JSON entry.${partialHint} ${message}`,
      });
    }
  }

  return values;
}

export function appendJsonl(file: string, value: unknown): void {
  try {
    ensureDir(path.dirname(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "WRITE_PREPARE_FAILED",
      file,
      operation: "appendJsonl",
      cause: error,
      message: `Failed to prepare directory for JSONL append to ${file}: ${message}`,
    });
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value) + "\n";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "SERIALIZE_FAILED",
      file,
      operation: "appendJsonl",
      cause: error,
      message: `Failed to serialize JSONL record for ${file}: ${message}`,
    });
  }

  try {
    fs.appendFileSync(file, serialized, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "WRITE_FAILED",
      file,
      operation: "appendJsonl",
      cause: error,
      message: `Failed to append JSONL to ${file}: append did not complete successfully. ${message}`,
    });
  }
}

export function overwriteJsonl(file: string, values: unknown[]): void {
  try {
    ensureDir(path.dirname(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "WRITE_PREPARE_FAILED",
      file,
      operation: "overwriteJsonl",
      cause: error,
      message: `Failed to prepare directory for JSONL overwrite to ${file}: ${message}`,
    });
  }

  let serialized: string;
  try {
    serialized = values.map((value) => JSON.stringify(value)).join("\n");
    if (serialized.length > 0) {
      serialized += "\n";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "SERIALIZE_FAILED",
      file,
      operation: "overwriteJsonl",
      cause: error,
      message: `Failed to serialize JSONL contents for ${file}: ${message}`,
    });
  }

  try {
    fs.writeFileSync(file, serialized, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StorageError({
      code: "WRITE_FAILED",
      file,
      operation: "overwriteJsonl",
      cause: error,
      message: `Failed to overwrite JSONL at ${file}: write did not complete successfully. ${message}`,
    });
  }
}

export function antcodePath(root: string, name: string): string {
  return path.join(root, ".antcode", name);
}


// ── Buffered Storage ──
// Reduces syscall overhead by batching JSONL writes.

interface BufferEntry {
  lines: string[];
  timer?: NodeJS.Timeout;
}

export class BufferedStorage {
  private buffers = new Map<string, BufferEntry>();
  private maxLines = 50;
  private flushIntervalMs = 5000;

  appendJsonl(file: string, value: unknown): void {
    let entry = this.buffers.get(file);
    if (!entry) {
      entry = { lines: [] };
      entry.timer = setTimeout(() => this.flushFile(file), this.flushIntervalMs);
      this.buffers.set(file, entry);
    }
    entry.lines.push(JSON.stringify(value));
    if (entry.lines.length >= this.maxLines) {
      this.flushFile(file);
    }
  }

  flushFile(file: string): void {
    const entry = this.buffers.get(file);
    if (!entry || entry.lines.length === 0) return;
    const data = entry.lines.join("\n") + "\n";
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.buffers.delete(file);
    try {
      ensureDir(path.dirname(file));
      fs.appendFileSync(file, data, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StorageError({
        code: "WRITE_FAILED",
        file,
        operation: "appendJsonl",
        cause: error,
        message: `Failed to append buffered JSONL to ${file}: ${message}`,
      });
    }
  }

  flushAll(): void {
    for (const file of Array.from(this.buffers.keys())) {
      this.flushFile(file);
    }
  }

  close(): void {
    this.flushAll();
    for (const entry of this.buffers.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.buffers.clear();
  }
}

export const globalBuffer = new BufferedStorage();

import fs from "node:fs";
import path from "node:path";

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
  let content: string;

  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError && nodeError.code === "ENOENT") {
      return { value: fallback, found: false };
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
    return { value: JSON.parse(content) as T, found: true };
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

export function readJson<T>(file: string, fallback: T): T {
  return tryReadJson(file, fallback).value;
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
      values.push(JSON.parse(line) as T);
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

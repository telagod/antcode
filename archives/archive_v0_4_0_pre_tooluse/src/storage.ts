import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
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
    throw new Error(`Failed to read JSON from ${file}: ${message}`);
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse JSON from ${file}: file exists but contains malformed JSON. ${message}`,
    );
  }
}

export function writeJson(file: string, value: unknown): void {
  try {
    ensureDir(path.dirname(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare directory for JSON write to ${file}: ${message}`);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2) + "\n";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to serialize JSON for ${file}: ${message}`);
  }

  try {
    fs.writeFileSync(file, serialized, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write JSON to ${file}: write did not complete successfully. ${message}`);
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
    throw new Error(`Failed to read JSONL from ${file}: ${message}`);
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
      const partialHint = isLastLine && !hasTrailingNewline
        ? " The final line may be partial or truncated."
        : "";
      throw new Error(
        `Failed to parse JSONL from ${file} at line ${index + 1}: malformed JSON entry.${partialHint} ${message}`,
      );
    }
  }

  return values;
}

export function appendJsonl(file: string, value: unknown): void {
  try {
    ensureDir(path.dirname(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare directory for JSONL append to ${file}: ${message}`);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value) + "\n";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to serialize JSONL record for ${file}: ${message}`);
  }

  try {
    fs.appendFileSync(file, serialized, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to append JSONL to ${file}: append did not complete successfully. ${message}`,
    );
  }
}

export function overwriteJsonl(file: string, values: unknown[]): void {
  try {
    ensureDir(path.dirname(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare directory for JSONL overwrite to ${file}: ${message}`);
  }

  let serialized: string;
  try {
    serialized = values.map((value) => JSON.stringify(value)).join("\n");
    if (serialized.length > 0) {
      serialized += "\n";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to serialize JSONL contents for ${file}: ${message}`);
  }

  try {
    fs.writeFileSync(file, serialized, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to overwrite JSONL at ${file}: write did not complete successfully. ${message}`,
    );
  }
}

export function antcodePath(root: string, name: string): string {
  return path.join(root, ".antcode", name);
}

import { AllOps } from "./operations";
import path from "node:path";

export interface ToolDef {
  name: string;
  description: string;
  promptSnippet: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ops: AllOps, cwd: string): string;
}

const readTool: ToolDef = {
  name: "read",
  description: "Read a file's contents. Returns the text content or an error message.",
  promptSnippet: "read(path, offset?, limit?) — read file contents",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path" },
      offset: { type: "number", description: "Start line (0-based)" },
      limit: { type: "number", description: "Max lines to return" },
    },
    required: ["path"],
  },
  execute(args, ops, cwd) {
    const abs = path.resolve(cwd, args.path as string);
    const content = ops.readFile(abs);
    if (content === null) return `error: file not found: ${args.path}`;
    const lines = content.split("\n");
    const offset = (args.offset as number) ?? 0;
    const limit = (args.limit as number) ?? lines.length;
    return lines.slice(offset, offset + limit).map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
  },
};

const writeTool: ToolDef = {
  name: "write",
  description: "Create or overwrite a file with the given content. Auto-creates parent directories.",
  promptSnippet: "write(path, content) — create or overwrite file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path" },
      content: { type: "string", description: "Complete file content" },
    },
    required: ["path", "content"],
  },
  execute(args, ops, cwd) {
    const abs = path.resolve(cwd, args.path as string);
    ops.writeFile(abs, args.content as string);
    const lines = (args.content as string).split("\n").length;
    return `wrote ${args.path} (${lines} lines)`;
  },
};
// TOOLS_PART2

const editTool: ToolDef = {
  name: "edit",
  description: "Apply targeted text replacements to a file. Supports multiple edits in one call.",
  promptSnippet: "edit(path, edits[{oldText, newText}]) — targeted text replacement",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact text to find" },
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["oldText", "newText"],
        },
        description: "Array of replacements to apply in order",
      },
    },
    required: ["path", "edits"],
  },
  execute(args, ops, cwd) {
    const abs = path.resolve(cwd, args.path as string);
    let content = ops.readFile(abs);
    if (content === null) return `error: file not found: ${args.path}`;
    const edits = args.edits as Array<{ oldText: string; newText: string }>;
    const results: string[] = [];
    for (const edit of edits) {
      if (content.includes(edit.oldText)) {
        content = content.replace(edit.oldText, edit.newText);
        results.push(`replaced ${edit.oldText.split("\n").length} lines`);
      } else {
        results.push(`oldText not found (${edit.oldText.slice(0, 40)}...)`);
      }
    }
    ops.writeFile(abs, content);
    return `edited ${args.path}: ${results.join("; ")}`;
  },
};

const bashTool: ToolDef = {
  name: "bash",
  description: "Execute a shell command and return stdout/stderr. Use for running tests, type checks, builds, or any CLI tool.",
  promptSnippet: "bash(command, timeout?) — run shell command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in ms (default 30000)" },
    },
    required: ["command"],
  },
  execute(args, ops, cwd) {
    const command = String(args.command ?? "");
    const normalized = command.toLowerCase();
    const invokesExperiment = normalized.includes("run-experiment") || normalized.includes("demo:real");
    const invokesRealMode = normalized.includes("--real") || normalized.includes("demo:real") || normalized.includes("antcode_llm_api_key");
    if (invokesExperiment && invokesRealMode) {
      return "exit=126\nblocked: nested real AntCode runs are not allowed from inside a workbench";
    }

    const { exitCode, stdout, stderr } = ops.exec(command, cwd, (args.timeout as number) ?? 30000);
    const out = [stdout, stderr].filter(Boolean).join("\n").slice(0, 4000);
    return `exit=${exitCode}\n${out}`;
  },
};

const grepTool: ToolDef = {
  name: "grep",
  description: "Search for a pattern in files. Returns matching lines with file paths and line numbers.",
  promptSnippet: "grep(pattern, glob?, ignoreCase?) — search files for pattern",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern" },
      glob: { type: "string", description: "File glob filter, e.g. *.ts" },
      ignoreCase: { type: "boolean", description: "Case insensitive search" },
      context: { type: "number", description: "Lines of context around matches" },
      limit: { type: "number", description: "Max result lines" },
    },
    required: ["pattern"],
  },
  execute(args, ops, cwd) {
    const result = ops.grep(args.pattern as string, cwd, {
      glob: args.glob as string | undefined,
      ignoreCase: args.ignoreCase as boolean | undefined,
      context: args.context as number | undefined,
      limit: (args.limit as number) ?? 30,
    });
    return result || "no matches";
  },
};

const findTool: ToolDef = {
  name: "find",
  description: "Find files by name pattern. Returns relative paths.",
  promptSnippet: "find(pattern, limit?) — find files by name",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "File name glob, e.g. *.ts" },
      limit: { type: "number", description: "Max results (default 50)" },
    },
    required: ["pattern"],
  },
  execute(args, ops, cwd) {
    const files = ops.find(args.pattern as string, cwd, { limit: (args.limit as number) ?? 50 });
    return files.length ? files.join("\n") : "no files found";
  },
};

const lsTool: ToolDef = {
  name: "ls",
  description: "List directory contents. Directories have a trailing /.",
  promptSnippet: "ls(path?) — list directory",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative directory path (default: .)" },
    },
  },
  execute(args, ops, cwd) {
    const abs = path.resolve(cwd, (args.path as string) ?? ".");
    const entries = ops.ls(abs);
    return entries.length ? entries.join("\n") : "empty directory";
  },
};

const doneTool: ToolDef = {
  name: "done",
  description: "Signal that all changes are complete. Call this after verifying your changes work.",
  promptSnippet: "done(notes) — signal completion",
  parameters: {
    type: "object",
    properties: {
      notes: { type: "array", items: { type: "string" }, description: "Summary of what you did" },
      tests_added: { type: "number", description: "Number of tests added" },
    },
    required: ["notes"],
  },
  execute(args) {
    return "done";
  },
};

export const ALL_TOOLS: ToolDef[] = [readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool, doneTool];

export function toolsToSchema(tools: ToolDef[]): Array<{ type: string; name: string; description: string; parameters: Record<string, unknown> }> {
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
}

export function buildToolSnippets(tools: ToolDef[]): string {
  return tools.map((t) => `- ${t.promptSnippet}`).join("\n");
}

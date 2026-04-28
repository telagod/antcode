import { Attempt, ExperienceKey, PatchArtifactManifest, StrategyGenome } from "./types";
import { RealTask } from "./tasks";
import { createLocalOps } from "./tools";
import { gatherInsights, formatInsightsForPrompt } from "./insights";
import { AgentAssignment, buildFocusPrompt, recordDiscovery, formatDiscoveriesForPrompt } from "./collaboration";
import path from "node:path";
import { createAgentRuntime, cacheKeyForTask, formatRuntimeSummary } from "./runtime";
import type { AgentRunResult } from "./runtime";

let attemptCounter = 0;

// REALWORKER_ATTEMPT

// === Shared reconnaissance — run once, inject into all agents' prefix ===
let cachedRecon: string | null = null;
let reconSlotId = -1;

export async function runSharedRecon(slotId: number): Promise<string> {
  const { createSlot, resetSlot, cleanupSlot } = await import("./verify");
  const slot = createSlot(slotId);
  try {
    resetSlot(slot);
    const ops = createLocalOps(slot);

    const fileList = ops.ls(slot);
    const srcFiles = ops.find("*.ts", slot, { limit: 30 });
    const structure = [
      `## Project Structure (shared recon)`,
      `### Root\n${fileList.join("\n")}`,
      `### Source Files\n${srcFiles.join("\n")}`,
    ].join("\n\n");

    cachedRecon = structure;
    reconSlotId = slotId;
    return structure;
  } finally {
    try {
      cleanupSlot(slot);
    } catch (e) {
      console.warn(`  cleanup warning: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

export function getSharedRecon(): string {
  return cachedRecon ?? "";
}

export interface RealAttemptResult {
  attempt: Attempt;
  mergeFiles?: Record<string, string>;
  artifact?: PatchArtifactManifest;
}

export async function realAttempt(
  key: ExperienceKey,
  genome: StrategyGenome,
  task?: RealTask,
  slotId = 0,
  autoMerge = false,
  assignment?: AgentAssignment,
): Promise<RealAttemptResult> {
  attemptCounter += 1;
  const id = `attempt_${String(attemptCounter).padStart(4, "0")}`;

  const { createSlot, resetSlot, cleanupSlot, createPatchArtifact } = await import("./verify");
  const slot = createSlot(slotId);

  try {
    resetSlot(slot);

    const ops = createLocalOps(slot);
    const insights = formatInsightsForPrompt(gatherInsights(process.cwd(), key.goal_pattern));

    // build input: focus area + shared discoveries + strategy + insights
    const focusPrompt = assignment ? buildFocusPrompt(assignment) : "";
    const discoveries = formatDiscoveriesForPrompt();
    const goalHint = task
      ? `## Task\n${task.description}`
      : `## Goal\nImprove code quality in this TypeScript project. Look for: missing error handling, type safety issues, dead code, missing exports, or code that could be cleaner.`;

    const recon = getSharedRecon();

    const input = [
      recon,
      goalHint,
      focusPrompt,
      discoveries,
      `## Strategy (${genome.id})\n- prefer_existing_pattern: ${genome.action_strategy.prefer_existing_pattern}\n- forbid_architecture_change: ${genome.action_strategy.forbid_architecture_change}\n- validation: ${genome.validation_strategy.required.join(", ")}`,
      insights,
    ].filter(Boolean).join("\n\n");

    // cache key based on stable prefix (recon + goal), not variable parts
    const taskCacheKey = cacheKeyForTask(recon + goalHint);

    let result: AgentRunResult;
    try {
      result = await createAgentRuntime().run({ input, ops, cwd: slot, cacheKey: taskCacheKey });
      const u = result.totalUsage;
      const cacheRate = u.input_tokens ? (u.cached_tokens / u.input_tokens * 100).toFixed(1) : "0";
      console.log(`    tokens: in=${u.input_tokens} out=${u.output_tokens} cached=${u.cached_tokens} (${cacheRate}%)`);
      if (result.telemetry) console.log(`    ${formatRuntimeSummary(result.telemetry)}`);
    } catch (e) {
      return fallbackResult(id, key, genome, (e as Error).message.slice(0, 200));
    }

    if (result.filesChanged.length === 0) {
      return fallbackResult(id, key, genome, "no file changes");
    }

    const artifact = createPatchArtifact(
      slot,
      id,
      result.filesChanged,
      result.notes,
      result.bashResults,
    );

    // collect merge files before cleanup
    let mergeFiles: Record<string, string> | undefined;
    if (autoMerge) {
      mergeFiles = {};
      for (const f of result.filesChanged) {
        const content = ops.readFile(path.resolve(slot, f));
        if (content) mergeFiles[f] = content;
      }
      if (Object.keys(mergeFiles).length === 0) mergeFiles = undefined;
    }

    // determine success: files changed + bash verification or done called
    const hasFileChanges = result.filesChanged.length > 0;
    const calledDone = result.notes.length > 0;
    const lastBashPassed = result.bashResults.length > 0 && result.bashResults[result.bashResults.length - 1].startsWith("exit=0");
    const notesIndicateSuccess = result.notes.some((n) => {
      const l = n.toLowerCase();
      return l.includes("pass") || l.includes("verified") || l.includes("success") || l.includes("complete") || l.includes("done") || l.includes("fixed");
    });

    let attemptResult: Attempt["result"] = "failure";
    if (hasFileChanges && (calledDone || lastBashPassed || notesIndicateSuccess)) {
      attemptResult = "success";
    } else if (hasFileChanges) {
      attemptResult = "blocked";
    }

    if (attemptResult !== "success") mergeFiles = undefined;

    // record discoveries for other agents
    for (const f of result.filesChanged) {
      const summary = result.notes.slice(0, 2).join("; ").slice(0, 100) || `modified ${f}`;
      recordDiscovery({
        agentId: assignment?.agentId ?? 0,
        timestamp: new Date().toISOString(),
        file: f,
        finding: summary,
        fixed: attemptResult === "success",
      });
    }

    const attempt: Attempt = {
      id,
      timestamp: new Date().toISOString(),
      experience_key: key,
      strategy_genome_id: genome.id,
      worker: "other",
      result: attemptResult,
      files_changed: result.filesChanged,
      diff_lines: result.filesChanged.length * 10,
      tests_added: result.testsAdded,
      commands_run: [],
      boundary_violations: [],
      notes: [
        ...result.notes,
        `artifact:${artifact.id}`,
        `tokens:in=${result.totalUsage.input_tokens},out=${result.totalUsage.output_tokens},cached=${result.totalUsage.cached_tokens}`,
        ...(result.telemetry ? [formatRuntimeSummary(result.telemetry)] : []),
      ],
    };

    return { attempt, mergeFiles, artifact };
  } finally {
    try {
      cleanupSlot(slot);
    } catch (e) {
      console.warn(`  cleanup warning: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

function fallbackResult(id: string, key: ExperienceKey, genome: StrategyGenome, reason: string): RealAttemptResult {
  return {
    attempt: {
      id, timestamp: new Date().toISOString(), experience_key: key,
      strategy_genome_id: genome.id, worker: "other", result: "failure",
      files_changed: [], diff_lines: 0, tests_added: 0,
      commands_run: [], boundary_violations: [],
      notes: [`fallback: ${reason}`],
    },
  };
}

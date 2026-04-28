export type RuntimeEventKind =
  | "run_start"
  | "message_end"
  | "tool_start"
  | "tool_end"
  | "tool_blocked"
  | "timeout"
  | "run_end";

export interface RuntimeEvent {
  kind: RuntimeEventKind;
  at: string;
  elapsed_ms: number;
  detail: string;
}

export interface RuntimeTelemetry {
  runtime: "pi";
  started_at: string;
  finished_at?: string;
  elapsed_ms: number;
  timeout_ms: number;
  timed_out: boolean;
  tool_calls: number;
  blocked_tool_calls: number;
  assistant_messages: number;
  events: RuntimeEvent[];
}

export function createRuntimeTelemetry(timeoutMs: number): {
  telemetry: RuntimeTelemetry;
  record(kind: RuntimeEventKind, detail: string): void;
  finish(timedOut?: boolean): RuntimeTelemetry;
  elapsed(): number;
} {
  const started = Date.now();
  const telemetry: RuntimeTelemetry = {
    runtime: "pi",
    started_at: new Date(started).toISOString(),
    elapsed_ms: 0,
    timeout_ms: timeoutMs,
    timed_out: false,
    tool_calls: 0,
    blocked_tool_calls: 0,
    assistant_messages: 0,
    events: [],
  };

  function elapsed(): number {
    return Date.now() - started;
  }

  function record(kind: RuntimeEventKind, detail: string): void {
    if (kind === "tool_start") telemetry.tool_calls += 1;
    if (kind === "tool_blocked") telemetry.blocked_tool_calls += 1;
    if (kind === "message_end") telemetry.assistant_messages += 1;
    telemetry.events.push({
      kind,
      at: new Date().toISOString(),
      elapsed_ms: elapsed(),
      detail,
    });
  }

  function finish(timedOut = false): RuntimeTelemetry {
    telemetry.finished_at = new Date().toISOString();
    telemetry.elapsed_ms = elapsed();
    telemetry.timed_out = timedOut;
    record("run_end", timedOut ? "timed out" : "completed");
    telemetry.elapsed_ms = elapsed();
    return telemetry;
  }

  record("run_start", "pi runtime started");
  return { telemetry, record, finish, elapsed };
}

export function formatRuntimeSummary(telemetry: RuntimeTelemetry): string {
  return [
    `runtime:${telemetry.runtime}`,
    `elapsed_ms=${telemetry.elapsed_ms}`,
    `timeout_ms=${telemetry.timeout_ms}`,
    `timed_out=${telemetry.timed_out}`,
    `tools=${telemetry.tool_calls}`,
    `blocked=${telemetry.blocked_tool_calls}`,
    `assistant_messages=${telemetry.assistant_messages}`,
  ].join(",");
}

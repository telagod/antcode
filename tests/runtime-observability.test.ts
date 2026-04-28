import assert from "node:assert/strict";
import { createRuntimeTelemetry, formatRuntimeSummary } from "../src/runtime/observability";

const control = createRuntimeTelemetry(45000);
control.record("tool_start", "read");
control.record("message_end", "assistant tokens in=10 out=3");
const telemetry = control.finish(false);

assert.equal(telemetry.runtime, "pi");
assert.equal(telemetry.timed_out, false);
assert.equal(telemetry.tool_calls, 1);
assert.equal(telemetry.assistant_messages, 1);
assert.match(formatRuntimeSummary(telemetry), /runtime:pi/);
assert.match(formatRuntimeSummary(telemetry), /tools=1/);

console.log("runtime observability summarizes pi events");

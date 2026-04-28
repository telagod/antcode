import assert from "node:assert/strict";
import {
  PiAgentRuntime,
  cacheKeyForTask,
  createAgentRuntime,
  getAgentRuntimeKind,
} from "../src/runtime";

const first = cacheKeyForTask("same stable prompt");
const second = cacheKeyForTask("same stable prompt");
const different = cacheKeyForTask("different stable prompt");

assert.equal(first, second, "cache keys should be deterministic for the same prompt");
assert.notEqual(first, different, "cache keys should change when the prompt changes");
assert.equal(typeof new PiAgentRuntime().run, "function", "pi runtime should implement AgentRuntime.run");

process.env.ANTCODE_RUNTIME = "pi";
assert.equal(getAgentRuntimeKind(), "pi");
assert.ok(createAgentRuntime() instanceof PiAgentRuntime);

process.env.ANTCODE_RUNTIME = "pi-agent-core";
assert.equal(getAgentRuntimeKind(), "pi");
assert.ok(createAgentRuntime() instanceof PiAgentRuntime);

delete process.env.ANTCODE_RUNTIME;
assert.equal(getAgentRuntimeKind(), "pi");
assert.ok(createAgentRuntime() instanceof PiAgentRuntime);

console.log("single pi runtime abstraction is exportable");

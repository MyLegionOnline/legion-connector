// The OpenCode driver turns OpenCode's native SSE events into the connector's
// DriverEvents. This feeds `mapOpenCodeEvent` a fixture of one task lifecycle
// (a tool gets called, the tool finishes, the agent answers) and asserts the
// resulting status sequence. It does not spawn OpenCode — it proves the
// mapping table, which is what would go stale silently if OpenCode renamed
// an event.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStatusName, DriverEvent } from "../src/driver.js";
import { mapOpenCodeEvent, type OpenCodeEvent } from "../src/drivers/opencode.js";

const SESSION_ID = "sess-1";

function statusSequence(events: DriverEvent[]): AgentStatusName[] {
  return events
    .filter((e): e is Extract<DriverEvent, { kind: "status" }> => e.kind === "status")
    .map((e) => e.status);
}

function mapAll(native: OpenCodeEvent[]): DriverEvent[] {
  const out: DriverEvent[] = [];
  for (const event of native) {
    const mapped = mapOpenCodeEvent(event, SESSION_ID);
    if (mapped?.kind === "driver") out.push(mapped.event);
  }
  return out;
}

test("a tool call followed by an answer maps to the expected status sequence", () => {
  const events = mapAll([
    {
      type: "message.part.updated",
      properties: { part: { sessionID: SESSION_ID, type: "tool", tool: "bash", state: { status: "running" } } },
    },
    {
      type: "message.part.updated",
      properties: { part: { sessionID: SESSION_ID, type: "tool", tool: "bash", state: { status: "completed" } } },
    },
    { type: "message.updated", properties: { info: { sessionID: SESSION_ID } } },
  ]);
  assert.deepEqual(statusSequence(events), ["TOOL_CALL_STARTED", "TOOL_CALL_FINISHED", "LLM_RESPONSE_RECEIVED"]);
});

test("events of another session are ignored", () => {
  const events = mapAll([
    {
      type: "message.part.updated",
      properties: { part: { sessionID: "other", type: "tool", tool: "bash", state: { status: "running" } } },
    },
  ]);
  assert.deepEqual(events, []);
});

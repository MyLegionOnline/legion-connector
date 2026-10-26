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

// A usage limit or a bad key surfaces as `session.error` (or as retries in
// `session.status`) while the prompt request keeps waiting; the run must end
// with that reason instead of a generic "fetch failed" minutes later.
test("a provider error ends the run with its message", () => {
  const mapped = mapOpenCodeEvent(
    {
      type: "session.error",
      properties: {
        sessionID: SESSION_ID,
        error: { name: "APIError", data: { message: "Free usage limit reached.", isRetryable: false } },
      },
    },
    SESSION_ID,
  );
  assert.deepEqual(mapped, { kind: "failed", message: "APIError: Free usage limit reached." });
});

test("our own abort and another session's error do not end the run", () => {
  const aborted = mapOpenCodeEvent(
    { type: "session.error", properties: { sessionID: SESSION_ID, error: { name: "MessageAbortedError", data: {} } } },
    SESSION_ID,
  );
  const other = mapOpenCodeEvent(
    { type: "session.error", properties: { sessionID: "other", error: { name: "APIError", data: { message: "x" } } } },
    SESSION_ID,
  );
  assert.equal(aborted, null);
  assert.equal(other, null);
});

test("provider retries end the run only once the retry cap is reached", () => {
  const retry = (attempt: number) =>
    mapOpenCodeEvent(
      {
        type: "session.status",
        properties: { sessionID: SESSION_ID, status: { type: "retry", attempt, message: "Rate limited", next: 0 } },
      },
      SESSION_ID,
    );
  assert.equal(retry(1), null);
  assert.equal(retry(2), null);
  assert.deepEqual(retry(3), { kind: "failed", message: "The model provider keeps failing (attempt 3): Rate limited" });
});

// Seen live with OpenCode's free model: attempt 1, next attempt hours later
// (when the free limit resets), with the reason in `action`.
test("a retry scheduled far ahead ends the run on the first attempt", () => {
  const mapped = mapOpenCodeEvent(
    {
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: {
          type: "retry",
          attempt: 1,
          message: "Free usage exceeded, subscribe to Go",
          action: { reason: "free_tier_limit", message: "Subscribe to OpenCode Go." },
          next: Date.now() + 6 * 3600_000,
        },
      },
    },
    SESSION_ID,
  );
  assert.deepEqual(mapped, {
    kind: "failed",
    message: "The model provider keeps failing (attempt 1): Free usage exceeded, subscribe to Go Subscribe to OpenCode Go.",
  });
});

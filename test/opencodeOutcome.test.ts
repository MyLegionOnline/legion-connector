// What a finished OpenCode turn amounts to. Regression: a model that ended its
// turn having written nothing and called nothing (555 reasoning tokens, 6
// output tokens, no text part — seen on OpenCode's free default model) was
// reported to the Hub as a successful task with the summary "(no summary
// returned)", and the room's ChatMaster rejected work nobody had done.

import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_REPLY_NUDGE, outcomeOf, type OpenCodePromptResponse } from "../src/drivers/opencode.js";

const info = { providerID: "opencode", modelID: "big-pickle", tokens: { input: 2768, output: 6 } };

test("a reply with text is a normal result", () => {
  const o = outcomeOf({ info, parts: [{ type: "text", text: "  Done: 1) edited 2) reloaded 3) HTTP 200 " }] });
  assert.deepEqual({ empty: o.empty, failed: o.failed, summary: o.summary }, {
    empty: false,
    failed: false,
    summary: "Done: 1) edited 2) reloaded 3) HTTP 200",
  });
});

test("a reply with no text and no tool call is empty, and says so", () => {
  const o = outcomeOf({ info, parts: [{ type: "step-start" }, { type: "step-finish" }] });
  assert.equal(o.empty, true);
  assert.equal(o.failed, true);
  assert.match(o.summary, /empty reply/);
  assert.match(o.summary, /opencode\/big-pickle/);
  assert.match(o.summary, /6 output tokens/);
  assert.match(o.summary, /nothing was done/);
  assert.doesNotMatch(o.summary, /no summary returned/);
});

test("a reply that only called tools is not empty", () => {
  const o = outcomeOf({ info, parts: [{ type: "tool" }] });
  assert.equal(o.empty, false);
  assert.equal(o.failed, false);
});

test("a provider error is a failure with its own message, not an empty reply", () => {
  const response: OpenCodePromptResponse = {
    info: { ...info, error: { name: "ApiError", data: { message: "rate limited" } } },
    parts: [],
  };
  const o = outcomeOf(response);
  assert.equal(o.empty, false);
  assert.equal(o.failed, true);
  assert.equal(o.summary, "ApiError: rate limited");
});

test("the nudge asks for the work, not for an apology", () => {
  assert.match(EMPTY_REPLY_NUDGE, /Carry out the task/);
});

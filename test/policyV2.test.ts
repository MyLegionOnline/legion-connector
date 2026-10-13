// confirm_ops for OpenCode 2.x: `shell` rules in an ordered `permissions` list,
// where the last matching rule wins. Same promise as the 1.x map of bash rules:
// the rules are appended after the operator's own and verified in the server's
// effective config, otherwise the task does not run.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInlineConfigV2, confirmShellRules, missingConfirmRulesV2 } from "../src/policy.js";

test("each confirm_ops prefix becomes shell/ask rules, also behind sudo", () => {
  const rules = confirmShellRules(["rm"]);
  assert.deepEqual(
    rules.map((r) => r.resource),
    ["rm", "rm *", "sudo rm", "sudo rm *"],
  );
  assert.ok(rules.every((r) => r.action === "shell" && r.effect === "ask"));
});

test("no confirm_ops means no inline config", () => {
  assert.equal(buildInlineConfigV2([]), null);
});

test("the confirm rules go after the operator's own permissions, which are kept", () => {
  const own = { action: "shell", resource: "rm *", effect: "allow" };
  const built = buildInlineConfigV2(["rm"], JSON.stringify({ model: "x/y", permissions: [own] }));
  assert.ok(built);
  const parsed = JSON.parse(built.json) as { model: string; permissions: Array<{ resource: string; effect: string }> };
  assert.equal(parsed.model, "x/y");
  assert.deepEqual(parsed.permissions[0], own);
  const last = parsed.permissions.filter((p) => p.resource === "rm *").pop();
  assert.equal(last?.effect, "ask", "the last matching rule wins, so the ask must come last");
});

test("verification passes only when the ask rules are in force in the effective config", () => {
  const rules = confirmShellRules(["rm"]);
  const doc = (permissions: unknown) => ({ type: "document", info: { permissions } });
  assert.deepEqual(missingConfirmRulesV2([doc(rules)], rules), []);
  // not there at all:
  assert.equal(missingConfirmRulesV2([doc([])], rules).length, 4);
  assert.equal(missingConfirmRulesV2({ not: "a list" }, rules).length, 4);
  // there, but a later (higher priority) document allows the same command:
  const later = doc([{ action: "shell", resource: "rm *", effect: "allow" }]);
  assert.deepEqual(missingConfirmRulesV2([doc(rules), later], rules), ["rm *"]);
  // directory entries carry no rules and are skipped:
  assert.deepEqual(missingConfirmRulesV2([{ type: "directory", path: "/x" }, doc(rules)], rules), []);
});

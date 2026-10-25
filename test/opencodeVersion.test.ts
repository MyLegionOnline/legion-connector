// Which OpenCode is installed decides which driver runs a task: a wrong guess
// would speak the wrong protocol to the server, so the choice and the refusals
// are pinned down here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { apiFromSpecs, parseOpenCodeVersion, resolveApi } from "../src/drivers/opencodeVersion.js";

test("a version is read out of whatever `opencode --version` prints", () => {
  assert.equal(parseOpenCodeVersion("1.18.30")?.text, "1.18.30");
  assert.equal(parseOpenCodeVersion("opencode v2.0.28\n")?.major, 2);
  assert.equal(parseOpenCodeVersion("no digits here"), null);
});

test("1.18+ gets the v1 driver and 2.x the v2 driver", () => {
  assert.deepEqual(resolveApi("auto", "1.18.30"), { ok: true, api: "v1", version: "1.18.30" });
  assert.deepEqual(resolveApi(undefined, "1.19.0"), { ok: true, api: "v1", version: "1.19.0" });
  assert.deepEqual(resolveApi("auto", "2.0.28"), { ok: true, api: "v2", version: "2.0.28" });
});

test("a 1.x older than 1.18 is refused with the install command", () => {
  const r = resolveApi("auto", "1.17.9");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "opencode_version_unsupported");
    assert.match(r.message, /npm i -g opencode-ai@1\.18\.30/);
  }
});

test("a newer major than any checked is tried as v2, with a warning", () => {
  const r = resolveApi("auto", "3.1.0");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.api, "v2");
    assert.match(r.warning ?? "", /newer than any version/);
  }
});

test("an unreadable version asks for the api setting; the setting overrides the version", () => {
  const r = resolveApi("auto", "weird build");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "opencode_version_unknown");
    assert.match(r.message, /api = "v1"/);
  }
  assert.deepEqual(resolveApi("v2", "weird build"), { ok: true, api: "v2", version: null });
  assert.deepEqual(resolveApi("v1", "2.0.28"), { ok: true, api: "v1", version: "2.0.28" });
});

test("the live spec tells the generations apart", () => {
  const v1Doc = { openapi: "3.1.0", paths: { "/session": {}, "/event": {} } };
  const v2Spec = { info: { title: "opencode HttpApi" }, paths: { "/api/session": {} } };
  assert.equal(apiFromSpecs(null, v1Doc), "v1");
  assert.equal(apiFromSpecs(v2Spec, null), "v2");
  // v2 answers /doc with its web app (not JSON), v1 has no /openapi.json:
  assert.equal(apiFromSpecs(null, null), null);
  assert.equal(apiFromSpecs({ paths: { "/other": {} } }, { paths: { "/other": {} } }), null);
});

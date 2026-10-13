// Local policy: work_dirs, confirm_ops and room variables. The Hub only
// suggests; the machine's own configuration decides.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildInlineConfig,
  confirmBashRules,
  isPathAllowed,
  missingConfirmRules,
  resolveWorkDir,
  sanitizeRoomVariables,
} from "../src/policy.js";

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "legion-policy-"));
}

test("no work_dirs means no restriction and no default directory", () => {
  const cfg = { work_dirs: [] };
  assert.equal(isPathAllowed(cfg, "/anywhere"), true);
  assert.deepEqual(resolveWorkDir(cfg, null), { ok: true, dir: null });
});

test("a directory inside a work_dir is allowed, a sibling with the same prefix is not", () => {
  const root = tempRoot();
  try {
    const app = path.join(root, "app");
    mkdirSync(path.join(app, "sub"), { recursive: true });
    mkdirSync(path.join(root, "app-evil"));
    const cfg = { work_dirs: [app] };
    assert.equal(isPathAllowed(cfg, app), true);
    assert.equal(isPathAllowed(cfg, path.join(app, "sub")), true);
    assert.equal(isPathAllowed(cfg, path.join(root, "app-evil")), false);
    assert.equal(isPathAllowed(cfg, root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dot-dot segments cannot climb out of a work_dir", () => {
  const root = tempRoot();
  try {
    const app = path.join(root, "app");
    mkdirSync(app);
    const cfg = { work_dirs: [app] };
    assert.equal(isPathAllowed(cfg, path.join(app, "..", "secret")), false);
    assert.equal(isPathAllowed(cfg, path.join(app, "sub", "..", "..")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink inside a work_dir that points outside is refused", (t) => {
  const root = tempRoot();
  try {
    const app = path.join(root, "app");
    const outside = path.join(root, "outside");
    mkdirSync(app);
    mkdirSync(outside);
    try {
      symlinkSync(outside, path.join(app, "link"), "dir");
    } catch {
      t.skip("symlinks are not available here");
      return;
    }
    assert.equal(isPathAllowed({ work_dirs: [app] }, path.join(app, "link")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkDir: hint inside is used, hint outside is refused, no hint defaults to the first work_dir", () => {
  const root = tempRoot();
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const cfg = { work_dirs: [first, second] };
    assert.deepEqual(resolveWorkDir(cfg, second), { ok: true, dir: second });
    assert.deepEqual(resolveWorkDir(cfg, null), { ok: true, dir: first });
    const outside = resolveWorkDir(cfg, root);
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.equal(outside.code, "cwd_not_allowed");
    const relative = resolveWorkDir(cfg, "first");
    assert.equal(relative.ok, false);
    if (!relative.ok) assert.equal(relative.code, "cwd_not_absolute");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relative work_dirs entry is refused as the default directory", () => {
  const result = resolveWorkDir({ work_dirs: ["relative/dir"] }, null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "work_dir_not_absolute");
});

test("confirmBashRules covers the prefix with and without arguments, also behind sudo", () => {
  assert.deepEqual(confirmBashRules(["systemctl restart", " rm ", ""]), {
    "systemctl restart": "ask",
    "systemctl restart *": "ask",
    "sudo systemctl restart": "ask",
    "sudo systemctl restart *": "ask",
    rm: "ask",
    "rm *": "ask",
    "sudo rm": "ask",
    "sudo rm *": "ask",
  });
  assert.equal(buildInlineConfig([]), null);
});

test("buildInlineConfig keeps an existing inline config and puts the confirm rules last", () => {
  const built = buildInlineConfig(
    ["rm"],
    JSON.stringify({ theme: "x", permission: { bash: { "*": "allow", "rm *": "allow" }, edit: "allow" } }),
  );
  assert.ok(built);
  const parsed = JSON.parse(built.json);
  assert.equal(parsed.theme, "x");
  assert.equal(parsed.permission.edit, "allow");
  assert.deepEqual(Object.keys(parsed.permission.bash), ["*", "rm", "rm *", "sudo rm", "sudo rm *"]);
  assert.equal(parsed.permission.bash["rm *"], "ask");
  assert.equal(parsed.permission.bash["*"], "allow");
});

test("buildInlineConfig turns a scalar bash permission into a catch-all rule", () => {
  const built = buildInlineConfig(["reboot"], JSON.stringify({ permission: { bash: "allow" } }));
  assert.ok(built);
  assert.equal(JSON.parse(built.json).permission.bash["*"], "allow");
});

test("missingConfirmRules reports rules the server did not apply", () => {
  const rules = confirmBashRules(["rm"]);
  assert.deepEqual(missingConfirmRules({ permission: { bash: { ...rules } } }, rules), []);
  assert.deepEqual(missingConfirmRules({ permission: { bash: { rm: "ask" } } }, rules), ["rm *", "sudo rm", "sudo rm *"]);
  assert.deepEqual(missingConfirmRules({ permission: { bash: { ...rules, "rm *": "allow" } } }, rules), ["rm *"]);
  assert.equal(missingConfirmRules({}, rules).length, 4);
  assert.equal(missingConfirmRules(null, rules).length, 4);
});

test("sanitizeRoomVariables drops names that would change the agent's own behaviour", () => {
  const { env, dropped } = sanitizeRoomVariables({
    APP_ENV: "prod",
    DEPLOY_HOST: "example.org",
    OPENCODE_CONFIG_CONTENT: "{}",
    opencode_permission: "{}",
    LD_PRELOAD: "/x.so",
    NODE_OPTIONS: "--require x",
    PATH: "/evil",
  });
  assert.deepEqual(env, { APP_ENV: "prod", DEPLOY_HOST: "example.org" });
  assert.deepEqual(dropped.sort(), ["LD_PRELOAD", "NODE_OPTIONS", "OPENCODE_CONFIG_CONTENT", "PATH", "opencode_permission"]);
  assert.deepEqual(sanitizeRoomVariables(undefined), { env: {}, dropped: [] });
});

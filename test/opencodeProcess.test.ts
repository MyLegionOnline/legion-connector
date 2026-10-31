// The connector owns the `opencode serve` it starts: a leftover server holds
// hundreds of MB, and on a small VPS two of them starved the next task. These
// pin down that a server ignoring SIGTERM still goes away, and that a
// `--version` that fails says why instead of always "is OpenCode installed?".

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { terminateServer, versionFailureMessage } from "../src/drivers/opencode.js";
import { readCliVersionDetailed } from "../src/drivers/opencodeVersion.js";

const posix = process.platform !== "win32";

test("a server that ignores SIGTERM is killed", { skip: !posix && "POSIX signals" }, async () => {
  const proc = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up')"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise((resolve) => proc.stdout?.once("data", resolve));
  const started = Date.now();
  await terminateServer(proc, 300);
  assert.equal(proc.signalCode, "SIGKILL");
  assert.ok(Date.now() - started < 2000);
});

test("a server that honours SIGTERM is not killed harder", { skip: !posix && "POSIX signals" }, async () => {
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); console.log('up')"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise((resolve) => proc.stdout?.once("data", resolve));
  await terminateServer(proc, 2000);
  assert.equal(proc.signalCode, "SIGTERM");
});

test("an already finished server is left alone", async () => {
  const proc = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => proc.once("exit", resolve));
  await terminateServer(proc, 100);
  assert.equal(proc.exitCode, 0);
});

test("a missing command is reported as not found", async () => {
  const read = await readCliVersionDetailed("legion-no-such-opencode-binary");
  assert.equal(read.output, null);
  assert.equal(read.failure, "not_found");
});

test("a command that does not answer in time is a timeout, not a missing install", { skip: !posix && "shebang script" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-version-"));
  const slow = join(dir, "opencode");
  writeFileSync(slow, "#!/bin/sh\nsleep 5\necho 1.18.30\n");
  chmodSync(slow, 0o755);
  const read = await readCliVersionDetailed(slow, 200);
  assert.deepEqual(read, { output: null, failure: "timeout" });
  assert.match(versionFailureMessage("opencode", read.failure), /did not answer/);
});

test("a working command returns its version", async () => {
  const read = await readCliVersionDetailed(process.execPath);
  assert.match(read.output ?? "", /^v\d+\.\d+\.\d+/);
  assert.equal(read.failure, undefined);
});

test("each cause gets its own message", () => {
  assert.match(versionFailureMessage("opencode", "not_found"), /installed and on the connector user's PATH/);
  assert.match(versionFailureMessage("opencode", "failed"), /failed/);
});

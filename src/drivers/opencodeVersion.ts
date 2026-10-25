// Which OpenCode is installed, and which API generation it speaks.
//
// 1.18.x serves OpenAPI at `/doc` with routes in the root (`/session`,
// `/event`); 2.x serves `/openapi.json` ("opencode HttpApi") with everything
// under `/api/…`, and answers `/doc` with its web app. The version number is
// read before the server starts (the inline config differs between the two);
// the live API is checked after it starts, so a surprise fails loudly rather
// than speaking the wrong protocol.

import { spawn } from "node:child_process";
import type { OpenCodeApi } from "./opencodeCommon.js";

/** Oldest 1.x the v1 driver was checked against. */
export const MIN_V1 = { major: 1, minor: 18, patch: 0 };
export const SUPPORTED_V1_INSTALL = "npm i -g opencode-ai@1.18.30";

export interface OpenCodeVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

export function parseOpenCodeVersion(output: string): OpenCodeVersion | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: `${m[1]}.${m[2]}.${m[3]}` };
}

export type ApiResolution =
  | { ok: true; api: OpenCodeApi; version: string | null; warning?: string }
  | { ok: false; code: "opencode_version_unsupported" | "opencode_version_unknown"; message: string };

/**
 * Pick the driver for the installed OpenCode. `override` (`[opencode] api` in
 * connector.toml) wins over the version, for custom builds whose `--version`
 * says nothing useful.
 */
export function resolveApi(override: OpenCodeApi | "auto" | undefined, versionOutput: string | null): ApiResolution {
  const version = versionOutput ? parseOpenCodeVersion(versionOutput) : null;
  if (override === "v1" || override === "v2") {
    return { ok: true, api: override, version: version?.text ?? null };
  }
  if (!version) {
    return {
      ok: false,
      code: "opencode_version_unknown",
      message:
        "could not read the OpenCode version from `opencode --version`. Set `api = \"v1\"` (1.x) or `api = \"v2\"` (2.x) " +
        "under [opencode] in connector.toml.",
    };
  }
  if (version.major === 1) {
    const old =
      version.minor < MIN_V1.minor || (version.minor === MIN_V1.minor && version.patch < MIN_V1.patch);
    if (old) {
      return {
        ok: false,
        code: "opencode_version_unsupported",
        message: `OpenCode ${version.text} is older than the oldest supported 1.x (1.18.0). Install a newer one: ${SUPPORTED_V1_INSTALL}`,
      };
    }
    return { ok: true, api: "v1", version: version.text };
  }
  if (version.major === 2) return { ok: true, api: "v2", version: version.text };
  if (version.major > 2) {
    return {
      ok: true,
      api: "v2",
      version: version.text,
      warning: `OpenCode ${version.text} is newer than any version this connector was checked against; trying the 2.x API`,
    };
  }
  return {
    ok: false,
    code: "opencode_version_unsupported",
    message: `OpenCode ${version.text} is not supported. Install 1.18.x (${SUPPORTED_V1_INSTALL}) or 2.x.`,
  };
}

/** What a running server's two spec documents say about its API. */
export function apiFromSpecs(openapiJson: unknown, docJson: unknown): OpenCodeApi | null {
  const v2 = openapiJson as { info?: { title?: string }; paths?: Record<string, unknown> } | null;
  if (v2?.paths && "/api/session" in v2.paths) return "v2";
  const v1 = docJson as { paths?: Record<string, unknown> } | null;
  if (v1?.paths && "/session" in v1.paths) return "v1";
  return null;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json(); // the other generation answers with HTML here — not JSON
  } catch {
    return null;
  }
}

export async function probeApi(baseUrl: string, headers: Record<string, string>): Promise<OpenCodeApi | null> {
  const [openapi, doc] = await Promise.all([
    fetchJson(`${baseUrl}/openapi.json`, headers),
    fetchJson(`${baseUrl}/doc`, headers),
  ]);
  return apiFromSpecs(openapi, doc);
}

/** `<command> --version`, or null if it cannot be run or prints nothing. */
export function readCliVersion(command: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      // On Windows an npm-installed `opencode` is a .cmd shim, which only a shell can run.
      const proc = spawn(command, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        shell: process.platform === "win32",
      });
      proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
      proc.stderr?.on("data", (c: Buffer) => (out += c.toString()));
      proc.on("error", () => finish(null));
      // A shell reports a missing command as text on stderr and a non-zero exit.
      proc.on("close", (code) => finish(code === 0 ? out.trim() || null : null));
    } catch {
      finish(null);
    }
  });
}

// connector.toml — local policy the Hub can read (via `hello.capabilities`)
// but never weaken: work dirs (enforced by policy.ts), which commands must be
// confirmed (turned into OpenCode permission rules by policy.ts), and which
// modes this installation accepts. Credentials (refresh token) are deliberately kept
// in a *separate* file, not in connector.toml — the toml is meant to be
// hand-edited and version-controllable; a token in it would leak into
// dotfile backups too easily.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import TOML from "@iarna/toml";

export interface ConnectorConfig {
  hub_url: string;
  agent_cli: "opencode";
  cli_version?: string;
  /** Filled in at start-up from the installed OpenCode; reported to the Hub in `hello`. */
  cli_api?: "v1" | "v2";
  work_dirs: string[];
  confirm_ops: string[];
  modes: Array<"operator">;
  opencode?: {
    command?: string;
    port?: number;
    password?: string;
    /** "auto" (default) reads `opencode --version`; "v1"/"v2" forces a driver for a build whose version says nothing. */
    api?: "auto" | "v1" | "v2";
    /** OpenCode 2.x: a database file of the connector's own (OPENCODE_DB), so it does not share the user's. */
    db?: string;
  };
}

export interface ConnectorCredentials {
  connector_id: string;
  refresh_token: string;
  host_fingerprint: string;
}

const DEFAULT_CONFIG: ConnectorConfig = {
  hub_url: "wss://localhost/api/v1/connector/ws",
  agent_cli: "opencode",
  work_dirs: [],
  confirm_ops: ["rm", "systemctl restart", "systemctl stop"],
  modes: ["operator"],
};

function stateDir(): string {
  return process.env.LEGION_CONNECTOR_HOME || join(homedir(), ".legion-connector");
}

export function configPath(): string {
  return process.env.LEGION_CONNECTOR_CONFIG || join(stateDir(), "connector.toml");
}

export function credentialsPath(): string {
  return process.env.LEGION_CONNECTOR_CREDENTIALS || join(stateDir(), "credentials.json");
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadConfig(path: string = configPath()): ConnectorConfig {
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = TOML.parse(readFileSync(path, "utf8")) as unknown as Partial<ConnectorConfig>;
  return { ...DEFAULT_CONFIG, ...raw };
}

export function saveConfig(config: ConnectorConfig, path: string = configPath()): void {
  ensureDir(path);
  writeFileSync(path, TOML.stringify(config as unknown as TOML.JsonMap), "utf8");
}

export function loadCredentials(path: string = credentialsPath()): ConnectorCredentials | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConnectorCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(
  creds: ConnectorCredentials,
  path: string = credentialsPath(),
): void {
  ensureDir(path);
  // 0600: this file holds the machine's refresh token.
  writeFileSync(path, JSON.stringify(creds, null, 2), "utf8");
  try {
    // Best-effort — chmod isn't meaningful on all platforms (e.g. Windows).
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
}

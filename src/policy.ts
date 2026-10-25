// Local policy checks. connector.toml is the machine owner's policy; the Hub
// can read it (via `hello.capabilities`) but nothing it sends in a `dispatch`
// frame may loosen it. Everything here is a pure function so it can be tested
// without a Hub or a real agent.

import { realpathSync } from "node:fs";
import path from "node:path";
import type { ConnectorConfig } from "./config.js";

export type WorkDirResult =
  | { ok: true; dir: string | null }
  | { ok: false; code: string; message: string };

/** Resolve symlinks when the path exists, so a link inside a work_dir cannot lead out of it. */
function canonical(p: string): string {
  let resolved = path.resolve(p);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // The path does not exist (yet): the lexical form is all there is.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Is `candidate` inside (or equal to) one of the configured work_dirs? An empty list means no restriction. */
export function isPathAllowed(config: Pick<ConnectorConfig, "work_dirs">, candidate: string): boolean {
  if (config.work_dirs.length === 0) return true;
  const target = canonical(candidate);
  return config.work_dirs.some((allowed) => {
    const root = canonical(allowed);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return target === root || target.startsWith(prefix);
  });
}

/**
 * Decide the directory a task runs in. A directory suggested by the Hub
 * (`cwd_hint`) is only honoured when it lies inside a configured work_dir;
 * without a hint the first work_dir is the default. With no work_dirs
 * configured nothing is enforced and the driver falls back to its own default.
 */
export function resolveWorkDir(
  config: Pick<ConnectorConfig, "work_dirs">,
  hint: string | null | undefined,
): WorkDirResult {
  if (hint) {
    if (!path.isAbsolute(hint)) {
      return { ok: false, code: "cwd_not_absolute", message: `working directory must be an absolute path: ${hint}` };
    }
    if (!isPathAllowed(config, hint)) {
      return {
        ok: false,
        code: "cwd_not_allowed",
        message: `working directory is outside the configured work_dirs: ${hint}`,
      };
    }
    return { ok: true, dir: hint };
  }
  const first = config.work_dirs[0];
  if (first === undefined) return { ok: true, dir: null };
  if (!path.isAbsolute(first)) {
    return { ok: false, code: "work_dir_not_absolute", message: `work_dirs entry must be an absolute path: ${first}` };
  }
  return { ok: true, dir: first };
}

/**
 * OpenCode `permission.bash` rules that force a confirmation for every command
 * starting with one of the `confirm_ops` prefixes (also behind `sudo`).
 * OpenCode splits compound commands, so `a && rm x` is matched on `rm x`.
 */
export function confirmBashRules(confirmOps: string[]): Record<string, "ask"> {
  const rules: Record<string, "ask"> = {};
  for (const raw of confirmOps) {
    const op = raw.trim();
    if (!op) continue;
    for (const pattern of [op, `${op} *`, `sudo ${op}`, `sudo ${op} *`]) {
      rules[pattern] = "ask";
    }
  }
  return rules;
}

/**
 * The inline OpenCode config (`OPENCODE_CONFIG_CONTENT`) carrying the
 * confirm_ops rules, or null when there is nothing to enforce. OpenCode merges
 * it after the project and user configs; with "the last matching rule wins"
 * the rules take precedence over an `allow` in opencode.json.
 */
export function buildInlineConfig(
  confirmOps: string[],
  existing?: string,
): { json: string; rules: Record<string, "ask"> } | null {
  const rules = confirmBashRules(confirmOps);
  if (Object.keys(rules).length === 0) return null;

  // An inline config the operator already exports to the connector's
  // environment is kept; the confirm rules are added after its own.
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // Not valid JSON: OpenCode would not have applied it either.
    }
  }
  const permission =
    base.permission && typeof base.permission === "object" ? { ...(base.permission as Record<string, unknown>) } : {};
  const bash = permission.bash;
  const bashRules: Record<string, unknown> =
    bash && typeof bash === "object" ? { ...(bash as Record<string, unknown>) } : typeof bash === "string" ? { "*": bash } : {};
  for (const [pattern, action] of Object.entries(rules)) {
    delete bashRules[pattern]; // re-insert so the rule sits after the operator's own
    bashRules[pattern] = action;
  }
  permission.bash = bashRules;
  return { json: JSON.stringify({ ...base, permission }), rules };
}

/** Which of the expected `ask` rules are absent from the effective OpenCode config (`GET /config`)? */
export function missingConfirmRules(effectiveConfig: unknown, rules: Record<string, "ask">): string[] {
  const bash = (effectiveConfig as { permission?: { bash?: unknown } } | null)?.permission?.bash;
  const present = bash && typeof bash === "object" ? (bash as Record<string, unknown>) : {};
  return Object.keys(rules).filter((pattern) => present[pattern] !== "ask");
}

export interface ShellRule {
  action: "shell";
  resource: string;
  effect: "ask";
}

/**
 * OpenCode 2.x counterpart of {@link confirmBashRules}: `shell` rules with the
 * `ask` effect (the 1.x `bash` action is called `shell` in 2.x, and rules are
 * an ordered list instead of a map).
 */
export function confirmShellRules(confirmOps: string[]): ShellRule[] {
  return Object.keys(confirmBashRules(confirmOps)).map((resource) => ({ action: "shell", resource, effect: "ask" }));
}

/**
 * The 2.x inline config (`OPENCODE_CONFIG_CONTENT`). 2.x takes `permissions` as
 * an ordered list where the last matching rule wins; the confirm rules are
 * appended after the operator's own, as in {@link buildInlineConfig}.
 */
export function buildInlineConfigV2(
  confirmOps: string[],
  existing?: string,
): { json: string; rules: ShellRule[] } | null {
  const rules = confirmShellRules(confirmOps);
  if (rules.length === 0) return null;

  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // Not valid JSON: OpenCode would not have applied it either.
    }
  }
  const own = Array.isArray(base.permissions) ? (base.permissions as unknown[]) : [];
  return { json: JSON.stringify({ ...base, permissions: [...own, ...rules] }), rules };
}

/**
 * Which expected `ask` rules are not in force in a 2.x `GET /api/config`? The
 * answer is a list of config entries from lowest to highest priority; the last
 * matching rule wins, so a rule counts only if no later rule for the same
 * action and resource says something else.
 */
export function missingConfirmRulesV2(entries: unknown, rules: ShellRule[]): string[] {
  const effective = new Map<string, string>();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const permissions = (entry as { info?: { permissions?: unknown } } | null)?.info?.permissions;
      if (!Array.isArray(permissions)) continue;
      for (const rule of permissions) {
        const r = rule as { action?: unknown; resource?: unknown; effect?: unknown };
        if (typeof r.action === "string" && typeof r.resource === "string" && typeof r.effect === "string") {
          effective.set(`${r.action}\u0000${r.resource}`, r.effect);
        }
      }
    }
  }
  return rules.filter((r) => effective.get(`${r.action}\u0000${r.resource}`) !== "ask").map((r) => r.resource);
}

const BLOCKED_ENV_PREFIXES = ["OPENCODE_", "LD_", "DYLD_", "NODE_"];
const BLOCKED_ENV_NAMES = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "IFS", "PWD", "TMPDIR"]);

/**
 * Room variables travel in the `dispatch` frame and end up in the agent's
 * environment. They are meant for things like APP_ENV or DEPLOY_HOST; names
 * that change how the agent or the loader behaves (permissions, PATH, preloads)
 * would let the Hub override the machine's policy, so they are dropped.
 */
export function sanitizeRoomVariables(vars: Record<string, string> | undefined | null): {
  env: Record<string, string>;
  dropped: string[];
} {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(vars ?? {})) {
    const upper = name.toUpperCase();
    const blocked =
      BLOCKED_ENV_NAMES.has(upper) || BLOCKED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
    if (blocked || typeof value !== "string") {
      dropped.push(name);
    } else {
      env[name] = value;
    }
  }
  return { env, dropped };
}

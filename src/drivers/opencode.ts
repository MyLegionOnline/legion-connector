// OpenCode driver.
//
// Deliberately NOT PTY/tmux scraping (the output of a terminal cannot reliably
// tell "a tool was called" from "a question was asked"): `opencode serve` exposes a headless HTTP server with a
// structured event stream. Two generations of that server exist and both are
// supported: 1.x (`opencode1.ts`, over `@opencode-ai/sdk`) and 2.x
// (`opencode2.ts`, a plain HTTP client). This file owns what they share — the
// server process, the dispatch lifecycle, the confirmation relay — and picks
// the backend from the installed OpenCode's version (`opencodeVersion.ts`).

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { AgentDriver, DispatchContext, DriverEventSink, DriverRun } from "../driver.js";
import { logger } from "../logger.js";
import { sanitizeRoomVariables } from "../policy.js";
import { OpenCodeV1Backend } from "./opencode1.js";
import { OpenCodeV2Backend } from "./opencode2.js";
import {
  EMPTY_REPLY_NUDGE,
  type OpenCodeApi,
  type OpenCodeBackend,
  type PendingAsk,
  basicAuthHeader,
  outcomeOf,
} from "./opencodeCommon.js";
import { type ApiResolution, SUPPORTED_V1_INSTALL, probeApi, readCliVersion, resolveApi } from "./opencodeVersion.js";

export interface OpenCodeDriverOptions {
  command?: string; // defaults to "opencode"
  port?: number; // 0 = pick any free port
  /**
   * Password for the local server (HTTP Basic). 1.x runs without one unless
   * this is set; 2.x always has one, so the connector makes up a random one.
   */
  password?: string;
  /** Which API generation to drive; `auto` (default) reads `opencode --version`. */
  api?: OpenCodeApi | "auto";
  /** 2.x only: a database file of the connector's own (`OPENCODE_DB`), so it does not share the user's. */
  db?: string;
  // connector.toml's confirm_ops: command prefixes that must always be
  // confirmed. They are handed to `opencode serve` as `ask` permission rules
  // (OPENCODE_CONFIG_CONTENT), on top of the project's opencode.json.
  confirmOps?: string[];
}

/** Which OpenCode is installed, and so which backend a task will use. */
export async function detectOpenCode(
  options: Pick<OpenCodeDriverOptions, "command" | "api"> = {},
): Promise<ApiResolution & { raw: string | null }> {
  const raw = await readCliVersion(options.command ?? "opencode");
  return { ...resolveApi(options.api, raw), raw };
}

async function waitForServer(baseUrl: string, probePath: string, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    // Each probe gets its own short budget — without this, a single fetch()
    // that hangs on a slow/congested link (observed on a resource-starved
    // VPS) can block past `timeoutMs` by minutes,
    // since the outer loop's deadline check only reruns once the current
    // fetch settles.
    const remaining = Math.max(0, deadline - Date.now());
    const probeTimeout = Math.min(2000, remaining || 2000);
    try {
      const res = await fetch(`${baseUrl}${probePath}`, { method: "GET", headers, signal: AbortSignal.timeout(probeTimeout) });
      if (res.ok || res.status === 404 || res.status === 401) return; // server is up and answering HTTP
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`opencode serve did not become ready in time: ${String(lastError)}`);
}

const NOOP_RUN: DriverRun = { answer: async () => {}, stop: async () => {} };

export class OpenCodeDriver implements AgentDriver {
  readonly name = "opencode";

  constructor(private readonly options: OpenCodeDriverOptions = {}) {}

  async start(ctx: DispatchContext, sink: DriverEventSink): Promise<DriverRun> {
    const command = this.options.command ?? "opencode";

    const detected = await detectOpenCode({ command, api: this.options.api });
    if (!detected.ok) {
      // A missing binary is a different problem from an unsupported one.
      const code = detected.raw === null && this.options.api !== "v1" && this.options.api !== "v2"
        ? "opencode_spawn_failed"
        : detected.code;
      const message = code === "opencode_spawn_failed" ? `could not run \`${command} --version\` — is OpenCode installed?` : detected.message;
      sink({ kind: "error", code, message });
      return NOOP_RUN;
    }
    if (detected.warning) logger.warn("opencode: " + detected.warning);
    const api = detected.api;
    logger.info("opencode: driving the API", { api, version: detected.version });

    const port = this.options.port ?? 4096 + Math.floor(Math.random() * 1000);
    const baseUrl = `http://127.0.0.1:${port}`;
    // The directory was already checked against work_dirs by the client; the
    // fallback only applies when no work_dirs are configured. opencode serve
    // must run in the directory the task works in: a session whose cwd differs
    // from the paths a tool touches hung or crashed the server in testing.
    const cwd = ctx.cwd_hint || process.cwd();

    const password = this.options.password ?? (api === "v2" ? randomBytes(24).toString("hex") : undefined);
    const headers: Record<string, string> = password ? { Authorization: basicAuthHeader(password) } : {};
    const backend: OpenCodeBackend =
      api === "v2" ? new OpenCodeV2Backend({ baseUrl, password: password as string }) : new OpenCodeV1Backend({ baseUrl, password });

    // Room variables come from the Hub: names that change how the agent or the
    // loader behaves are dropped, and the connector's own settings go last.
    const { env: roomEnv, dropped } = sanitizeRoomVariables(ctx.room_variables);
    if (dropped.length > 0) logger.warn("opencode: ignored room variables", { names: dropped });
    const env: NodeJS.ProcessEnv = { ...process.env, ...roomEnv };
    if (password) {
      env.OPENCODE_SERVER_PASSWORD = password; // 1.x name, still read by 2.x
      if (api === "v2") env.OPENCODE_PASSWORD = password;
    }
    if (api === "v2" && this.options.db) env.OPENCODE_DB = this.options.db;
    const confirmOps = this.options.confirmOps ?? [];
    const inline = backend.inlineConfig(confirmOps, process.env.OPENCODE_CONFIG_CONTENT);
    if (inline) env.OPENCODE_CONFIG_CONTENT = inline;

    let proc: ChildProcess;
    try {
      proc = spawn(command, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32", // an npm-installed `opencode` is a .cmd shim there
      });
    } catch (err) {
      // Most spawn failures (ENOENT) surface async via the 'error' event
      // handled below, but some (e.g. EINVAL for a malformed command path)
      // throw synchronously — either way this must not crash the connector.
      sink({ kind: "error", code: "opencode_spawn_failed", message: String(err) });
      return NOOP_RUN;
    }

    let settled = false;
    let spawnError: Error | null = null;
    // The server says why it quit (a database it cannot open, a taken port) on
    // stderr; the tail goes into the error instead of a bare exit code.
    let stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      logger.debug("opencode stderr", { line: text });
      stderrTail = (stderrTail + text).slice(-1500);
    });
    // Without this, a bad `opencode.command` (typo, missing binary) throws an
    // *unhandled* 'error' event and crashes the whole connector process
    // instead of surfacing as a normal dispatch failure — Node emits 'error'
    // on spawn failure (ENOENT) with no accompanying 'exit'.
    proc.on("error", (err) => {
      spawnError = err;
      if (!settled) {
        settled = true;
        sink({ kind: "error", code: "opencode_spawn_failed", message: String(err) });
      }
    });
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        const why = stderrTail.trim();
        sink({
          kind: "error",
          code: "opencode_exited",
          message: `opencode serve exited early (code=${code})${why ? `: ${why}` : ""}`,
        });
      }
    });

    /** Report a failure that happens before the task runs, and stop the server. */
    const abandon = (code: string, message: string): DriverRun => {
      proc.kill("SIGKILL");
      if (!settled) {
        settled = true;
        sink({ kind: "error", code, message });
      }
      return NOOP_RUN;
    };

    try {
      await waitForServer(baseUrl, api === "v2" ? "/openapi.json" : "/doc", headers, 15_000);
    } catch (err) {
      // spawnError (ENOENT etc.) is the more useful message when both fired.
      return abandon("opencode_start_failed", String(spawnError ?? err));
    }
    if (settled) return NOOP_RUN; // the process died while we were waiting

    try {
      await backend.verifyApi();
    } catch (err) {
      const actual = await probeApi(baseUrl, headers);
      const hint =
        actual && actual !== api
          ? ` The server on the port speaks the ${actual} API while \`${command} --version\` says ${detected.version ?? "?"}; ` +
            `set \`api = "${actual}"\` under [opencode] in connector.toml.`
          : api === "v1"
            ? ` Install a supported 1.x: ${SUPPORTED_V1_INSTALL}.`
            : "";
      return abandon("opencode_api_mismatch", `OpenCode ${detected.version ?? ""} does not match the ${api} driver: ${String(err)}.${hint}`);
    }

    // confirm_ops is a safety policy, so it fails closed: if the server did not
    // pick up the rules (an OpenCode version that ignores the inline config),
    // the task does not run.
    if (inline) {
      try {
        await backend.verifyConfirmRules(confirmOps);
      } catch (err) {
        return abandon(
          "confirm_ops_not_applied",
          `could not confirm that confirm_ops are active in opencode serve: ${String(err)}`,
        );
      }
    }

    let sessionId: string;
    try {
      sessionId = await backend.createSession(`legion-task-${ctx.task_id}`, cwd);
    } catch (err) {
      return abandon(
        "opencode_sdk_unavailable",
        `creating the OpenCode session failed — the driver needs to be checked against the ` +
          `installed opencode version (${api}): ${String(err)}`,
      );
    }

    sink({ kind: "status", status: "LLM_REQUEST_SENT" });

    // Questions the local agent put to the human (a tool awaiting confirmation,
    // a form), oldest first. opencode blocks the tool call on each, so there
    // is little else for the run to be doing; the next answer goes to the oldest.
    const pending: Array<{ questionId: string; ask: PendingAsk }> = [];
    const stream = new AbortController();

    void backend
      .events(
        sessionId,
        (event) => {
          if (event.kind === "driver") {
            sink(event.event);
          } else if (event.kind === "failed") {
            // The model call failed for good; the prompt request would only
            // return when it times out, so end the run with the real reason now.
            if (settled) return;
            settled = true;
            sink({ kind: "error", code: "opencode_model_failed", message: event.message });
            void backend.abort(sessionId).catch(() => {}).finally(() => {
              stream.abort();
              proc.kill("SIGTERM");
            });
          } else if (event.kind === "ask") {
            if (pending.some((p) => p.ask.id === event.ask.id)) return;
            const questionId = randomUUID();
            pending.push({ questionId, ask: event.ask });
            sink({
              kind: "ask_user",
              question_id: questionId,
              content: event.ask.content,
              options: event.ask.options,
            });
          } else {
            const i = pending.findIndex((p) => p.ask.id === event.id);
            if (i >= 0) pending.splice(i, 1);
          }
        },
        stream.signal,
      )
      .catch((err) => {
        if (stream.signal.aborted) return;
        sink({ kind: "error", code: "opencode_event_stream_failed", message: String(err) });
      });

    void (async () => {
      let response = await backend.prompt(sessionId, ctx.task_data_text);
      let outcome = outcomeOf(response);
      if (outcome.empty) {
        // A model can end its turn having said nothing and called nothing (seen
        // with OpenCode's free default model: 555 reasoning tokens, 6 output
        // tokens, no text part). Reporting that as a finished task made the Hub
        // reject a task nobody had worked on, so ask once more in the same
        // session before giving up.
        logger.warn("opencode: empty reply, asking the model to continue", { model: outcome.model });
        response = await backend.prompt(sessionId, EMPTY_REPLY_NUDGE);
        outcome = outcomeOf(response);
      }
      if (settled) return; // already failed from the event stream
      settled = true;
      sink({
        kind: "result",
        result: {
          status: outcome.failed ? "failure" : "success",
          summary: outcome.summary,
          artifacts: [],
          usage: {
            tokens: response.info?.tokens ? response.info.tokens.input + response.info.tokens.output : null,
            cost_usd: response.info?.cost ?? null,
          },
        },
      });
    })()
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        sink({ kind: "error", code: "opencode_chat_failed", message: String(err) });
      })
      .finally(() => {
        stream.abort();
        proc.kill("SIGTERM");
      });

    return {
      answer: async (text: string) => {
        const next = pending.shift();
        if (next) {
          // The pending question was "may the tool proceed?" (or a form), not a chat
          // message — connectorClient forwards both `proxy_message` and
          // `answer` frames through this same method with just text
          // (connector_reverse.py's ask_user relay joins selected option
          // labels, so this checks for our own option text, not a fixed
          // enum).
          await backend.answerAsk(sessionId, next.ask, text);
          return;
        }
        await backend.say(sessionId, text);
      },
      stop: async (_reason: string) => {
        try {
          await backend.abort(sessionId);
        } catch {
          // best-effort — the hard kill below is what guarantees the 5s bound
        }
        stream.abort();
        proc.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!proc.killed) proc.kill("SIGKILL");
      },
    };
  }
}

// What the single-file driver used to export, for the tests and any caller that imported it.
export { EMPTY_REPLY_NUDGE, outcomeOf } from "./opencodeCommon.js";
export type { TurnReply as OpenCodePromptResponse } from "./opencodeCommon.js";
export { mapOpenCodeEvent } from "./opencode1.js";
export type { OpenCodeEvent, OpenCodeMappedEvent, OpenCodePart, OpenCodePermission } from "./opencode1.js";

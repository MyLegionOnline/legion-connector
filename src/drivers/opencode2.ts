// OpenCode 2.x backend: a hand-written client over the HTTP API of
// `opencode serve` 2.x (no SDK exists for it). The API is described by
// `/openapi.json` ("opencode HttpApi", marked experimental), so the first thing
// the backend does is check the routes it needs against the live document.
//
// What differs from 1.x, and why this file is not a port of opencode1.ts:
//  - `POST /api/session/{id}/prompt` only *admits* the input and returns at
//    once. The end of the turn is a `session.execution.*` event; the reply is
//    read back from `GET /api/session/{id}/message`.
//  - Events are `data: {"id","type","data"}` frames on `GET /api/event`, a
//    volatile stream that drops events while disconnected, so after a
//    reconnect pending questions are re-read from the API.
//  - Access is HTTP Basic (user `opencode`); the password is always set.
//  - The working directory is part of session creation (`location.directory`).
//  - Confirmations are `permission.asked`/`…/permission/{id}/reply`; agent
//    questions are separate "forms" (`form.created`/`…/form/{id}/reply`).

import { realpathSync } from "node:fs";
import path from "node:path";
import type { AgentStatusName } from "../driver.js";
import { buildInlineConfigV2, confirmShellRules, missingConfirmRulesV2 } from "../policy.js";
import {
  type BackendEvent,
  type OpenCodeBackend,
  type PendingAsk,
  type TurnReply,
  basicAuthHeader,
  isApproval,
} from "./opencodeCommon.js";
import { apiFromSpecs } from "./opencodeVersion.js";

export interface OpenCodeV2Options {
  baseUrl: string;
  password: string;
}

/** Routes the backend calls. Checked against the live `/openapi.json` at start. */
export const V2_REQUIRED_ROUTES: Array<[method: string, path: string]> = [
  ["post", "/api/session"],
  ["get", "/api/session/active"],
  ["post", "/api/session/{sessionID}/prompt"],
  ["get", "/api/session/{sessionID}/message"],
  ["post", "/api/session/{sessionID}/interrupt"],
  ["get", "/api/session/{sessionID}/permission"],
  ["post", "/api/session/{sessionID}/permission/{requestID}/reply"],
  ["get", "/api/session/{sessionID}/form"],
  ["post", "/api/session/{sessionID}/form/{formID}/reply"],
  ["delete", "/api/session/{sessionID}/form/{formID}"],
  ["get", "/api/event"],
  ["get", "/api/config"],
];

/** The required routes the document lacks, as `METHOD /path`. */
export function missingRoutes(spec: unknown): string[] {
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> } | null)?.paths ?? {};
  return V2_REQUIRED_ROUTES.filter(([method, route]) => !paths[route]?.[method]).map(
    ([method, route]) => `${method.toUpperCase()} ${route}`,
  );
}

/** Splits an SSE byte stream into the `data:` payload of each event. Comments (heartbeats) are dropped. */
export class SseParser {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  }
}

export interface V2Frame {
  id?: string;
  type: string;
  data?: Record<string, unknown>;
}

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const status = (s: AgentStatusName, detail?: Record<string, unknown>): BackendEvent => ({
  kind: "driver",
  event: { kind: "status", status: s, ...(detail ? { detail } : {}) },
});

/**
 * One native event of this session as a backend event, or null for the ones the
 * Hub has no use for. `toolNames` remembers the name announced by
 * `session.tool.input.started`, since the later events carry only the call id.
 * Pure, so the mapping table is testable without a running server.
 */
export function mapOpenCodeV2Event(
  frame: V2Frame,
  sessionId: string,
  toolNames: Map<string, string> = new Map(),
): BackendEvent | null {
  const data = rec(frame.data);

  if (frame.type === "form.created") {
    const form = rec(data.form);
    if (form.sessionID !== sessionId) return null;
    return { kind: "ask", ask: formAsk(form) };
  }
  if (frame.type === "form.replied" || frame.type === "form.cancelled") {
    if (data.sessionID !== sessionId || typeof data.id !== "string") return null;
    return { kind: "ask_resolved", id: data.id };
  }
  if (data.sessionID !== sessionId) return null;

  switch (frame.type) {
    case "session.step.started":
      return status("LLM_REQUEST_SENT");
    case "session.step.ended":
    case "session.step.failed":
      return status("LLM_RESPONSE_RECEIVED");
    case "session.text.started":
    case "session.text.delta":
    case "session.text.ended":
    case "session.reasoning.started":
    case "session.reasoning.delta":
      return status("LLM_HEARTBEAT");
    case "session.reasoning.ended":
      // The finished text, not the deltas: one event per reasoning block.
      return typeof data.text === "string" && data.text
        ? { kind: "driver", event: { kind: "reasoning", content: data.text } }
        : null;
    case "session.tool.input.started": {
      const name = typeof data.name === "string" ? data.name : undefined;
      if (typeof data.id === "string" && name) toolNames.set(data.id, name);
      return status("TOOL_CALL_STARTED", { tool: name });
    }
    case "session.tool.success":
    case "session.tool.failed": {
      const tool = typeof data.id === "string" ? toolNames.get(data.id) : undefined;
      return status("TOOL_CALL_FINISHED", { tool });
    }
    case "session.status": {
      const type = rec(data.status).type;
      if (type === "idle") return status("WAITING_PEER");
      return status("LLM_HEARTBEAT");
    }
    case "permission.asked":
      return { kind: "ask", ask: permissionAsk(data) };
    case "permission.replied":
      return typeof data.id === "string" ? { kind: "ask_resolved", id: data.id } : null;
    default:
      return null;
  }
}

function permissionAsk(request: Record<string, unknown>): PendingAsk {
  const resources = Array.isArray(request.resources) ? request.resources.map(String).join(", ") : "";
  const command = (request.metadata as { command?: string } | undefined)?.command;
  const detail = command || resources || String(request.action ?? "");
  return {
    id: String(request.id),
    kind: "permission",
    content: `The local agent asks for confirmation (${String(request.action)}): ${detail}`,
    options: ["Allow", "Deny"],
  };
}

function formAsk(form: Record<string, unknown>): PendingAsk {
  const fields = Array.isArray(form.fields) ? form.fields.map(rec) : [];
  const lines = fields.map((f) => {
    const label = String(f.title ?? f.key ?? "");
    return f.description ? `- ${label}: ${String(f.description)}` : `- ${label}`;
  });
  const first = fields[0] ?? {};
  const options = Array.isArray(first.options)
    ? first.options.map((o) => String(rec(o).label ?? rec(o).value ?? "")).filter(Boolean).slice(0, 4)
    : [];
  return {
    id: String(form.id),
    kind: "form",
    content: [`The local agent asks: ${String(form.title ?? "")}`, ...lines].join("\n"),
    options,
    raw: form,
  };
}

interface V2Message {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
  model?: { id?: string; providerID?: string };
  cost?: number;
  tokens?: { input?: number; output?: number };
  error?: { type?: string; message?: string };
  outcome?: string;
}

const structured = (error: { type?: string; message?: string }) => ({
  name: error.type,
  data: { message: error.message },
});

/**
 * The reply to the latest prompt, from the session's messages (oldest first):
 * everything after the last user message. Normalised to the shape `outcomeOf`
 * judges: the text and tool calls of the final assistant message, any error
 * (a failed or interrupted loop is an error, not a silent empty reply), and
 * the tokens and cost of the whole turn.
 */
export function replyFromMessages(messages: V2Message[]): TurnReply {
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.type === "user") lastUser = i;
  });
  const tail = messages.slice(lastUser + 1);
  const assistants = tail.filter((m) => m.type === "assistant");
  const idle = [...tail].reverse().find((m) => m.type === "idle");
  const last = assistants[assistants.length - 1];

  const parts: TurnReply["parts"] = (last?.content ?? []).map((c) => ({ type: c.type ?? "", text: c.text }));
  if (!parts.some((p) => p.type === "tool") && assistants.some((a) => (a.content ?? []).some((c) => c.type === "tool"))) {
    parts.push({ type: "tool" });
  }

  let error: unknown;
  if (idle?.outcome === "interrupted") {
    error = { name: "Interrupted", data: { message: "the task was interrupted before it finished" } };
  } else if (idle?.error) {
    error = structured(idle.error);
  } else if (last?.error) {
    error = structured(last.error);
  } else if (idle?.outcome === "failed") {
    error = { name: "Failed", data: { message: "the agent loop failed" } };
  }

  const sum = (pick: (m: V2Message) => number | undefined) =>
    assistants.reduce((total, m) => total + (pick(m) ?? 0), 0);
  return {
    info: {
      error,
      cost: assistants.length ? sum((m) => m.cost) : undefined,
      tokens: assistants.length
        ? { input: sum((m) => m.tokens?.input), output: sum((m) => m.tokens?.output) }
        : undefined,
      providerID: last?.model?.providerID,
      modelID: last?.model?.id,
    },
    parts,
  };
}

function canonical(p: string): string {
  let resolved = path.resolve(p);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // does not exist here: the lexical form is all there is
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class OpenCodeV2Backend implements OpenCodeBackend {
  readonly api = "v2" as const;
  /** When each session's last agent loop ended (from `session.execution.*`). */
  private readonly executionEnded = new Map<string, number>();
  private lastHeartbeat = 0;

  constructor(private readonly options: OpenCodeV2Options) {}

  private headers(): Record<string, string> {
    return { Authorization: basicAuthHeader(this.options.password) };
  }

  private async request(
    method: string,
    route: string,
    opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const url = new URL(this.options.baseUrl + route);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { ...this.headers(), ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${route} answered ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined;
    return res.json().catch(() => undefined);
  }

  async verifyApi(): Promise<void> {
    const spec = await this.request("GET", "/openapi.json");
    if (apiFromSpecs(spec, null) !== "v2") throw new Error("the server's /openapi.json is not the OpenCode 2.x API");
    const missing = missingRoutes(spec);
    if (missing.length > 0) {
      throw new Error(`this OpenCode lacks routes the connector uses (its API may have changed): ${missing.join(", ")}`);
    }
  }

  inlineConfig(confirmOps: string[], existing?: string): string | null {
    return buildInlineConfigV2(confirmOps, existing)?.json ?? null;
  }

  async verifyConfirmRules(confirmOps: string[]): Promise<void> {
    const entries = await this.request("GET", "/api/config", { timeoutMs: 5000 });
    const missing = missingConfirmRulesV2(entries, confirmShellRules(confirmOps));
    if (missing.length > 0) throw new Error(`rules not applied: ${missing.join(", ")}`);
  }

  async createSession(title: string, directory: string): Promise<string> {
    const created = rec(rec(await this.request("POST", "/api/session", { body: { title, location: { directory } } })).data);
    if (typeof created.id !== "string") throw new Error("POST /api/session returned no session id");
    // The v1 server once ran a session in a different directory than asked for;
    // a session that is not where the policy was checked must not run.
    const actual = rec(created.location).directory;
    if (typeof actual !== "string" || canonical(actual) !== canonical(directory)) {
      throw new Error(`the session was created in ${String(actual)}, not in ${directory}`);
    }
    return created.id;
  }

  async prompt(sessionId: string, text: string): Promise<TurnReply> {
    const since = Date.now();
    await this.request("POST", `/api/session/${sessionId}/prompt`, { body: { text } });
    await this.untilIdle(sessionId, since);
    const page = rec(
      await this.request("GET", `/api/session/${sessionId}/message`, { query: { order: "desc", limit: "100" } }),
    );
    const newestFirst = Array.isArray(page.data) ? (page.data as V2Message[]) : [];
    return replyFromMessages([...newestFirst].reverse());
  }

  /**
   * Resolves when the session's agent loop has ended. The event stream says so
   * first; it is volatile, though, so every few seconds the session list is
   * consulted too (a session absent from `/api/session/active` is idle).
   */
  private async untilIdle(sessionId: string, since: number): Promise<void> {
    let seenActive = false;
    let absent = 0;
    for (let tick = 0; ; tick++) {
      const ended = this.executionEnded.get(sessionId);
      if (ended !== undefined && ended >= since) return;
      await sleep(500);
      if (tick % 6 !== 5) continue;
      try {
        const active = rec(rec(await this.request("GET", "/api/session/active", { timeoutMs: 5000 })).data);
        if (sessionId in active) {
          seenActive = true;
          absent = 0;
        } else if (++absent >= 2 && (seenActive || Date.now() - since > 10_000)) {
          return;
        }
      } catch {
        // a hiccup on the poll is not the end of the turn
      }
    }
  }

  async say(sessionId: string, text: string): Promise<void> {
    // `steer` lands at the next step boundary of a running loop, instead of
    // waiting for it to go idle like a queued prompt would.
    await this.request("POST", `/api/session/${sessionId}/prompt`, { body: { text, delivery: "steer" } });
  }

  async answerAsk(sessionId: string, ask: PendingAsk, text: string): Promise<void> {
    if (ask.kind === "permission") {
      await this.request("POST", `/api/session/${sessionId}/permission/${ask.id}/reply`, {
        body: { decision: isApproval(text) ? "once" : "reject" },
      });
      return;
    }
    if (/^\s*(cancel|deny)\s*$/i.test(text)) {
      await this.request("DELETE", `/api/session/${sessionId}/form/${ask.id}`);
      return;
    }
    const field = rec(Array.isArray(rec(ask.raw).fields) ? (rec(ask.raw).fields as unknown[])[0] : undefined);
    const options = Array.isArray(field.options) ? field.options.map(rec) : [];
    const wanted = text.trim().toLowerCase();
    const chosen = options.find(
      (o) => String(o.label ?? "").toLowerCase() === wanted || String(o.value ?? "").toLowerCase() === wanted,
    );
    await this.request("POST", `/api/session/${sessionId}/form/${ask.id}/reply`, {
      body: { answer: { [String(field.key)]: chosen ? String(chosen.value) : text } },
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.request("POST", `/api/session/${sessionId}/interrupt`, { timeoutMs: 4000 });
  }

  async events(sessionId: string, onEvent: (event: BackendEvent) => void, signal: AbortSignal): Promise<void> {
    const pending = new Map<string, PendingAsk>();
    const toolNames = new Map<string, string>();
    const emit = (event: BackendEvent) => {
      if (event.kind === "ask") pending.set(event.ask.id, event.ask);
      if (event.kind === "ask_resolved") pending.delete(event.id);
      if (event.kind === "driver" && event.event.kind === "status" && event.event.status === "LLM_HEARTBEAT") {
        // Text arrives token by token; the Hub only needs to know the agent is alive.
        if (Date.now() - this.lastHeartbeat < 2000) return;
        this.lastHeartbeat = Date.now();
      }
      onEvent(event);
    };

    let failures = 0;
    let connectedBefore = false;
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.options.baseUrl}/api/event`, {
          headers: { ...this.headers(), Accept: "text/event-stream" },
          signal,
        });
        if (!res.ok || !res.body) throw new Error(`GET /api/event answered ${res.status}`);
        failures = 0;
        // Events are lost while the stream is down: re-read what is still waiting for an answer.
        if (connectedBefore) await this.reconcile(sessionId, pending, emit).catch(() => undefined);
        connectedBefore = true;

        const parser = new SseParser();
        const decoder = new TextDecoder();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          for (const data of parser.push(decoder.decode(chunk, { stream: true }))) {
            let frame: V2Frame;
            try {
              frame = JSON.parse(data) as V2Frame;
            } catch {
              continue;
            }
            if (frame.type.startsWith("session.execution.") && rec(frame.data).sessionID === sessionId) {
              if (frame.type !== "session.execution.started") this.executionEnded.set(sessionId, Date.now());
            }
            const mapped = mapOpenCodeV2Event(frame, sessionId, toolNames);
            if (mapped) emit(mapped);
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        if (++failures >= 8) throw err;
      }
      if (!signal.aborted) await sleep(Math.min(1000 * Math.max(failures, 1), 5000), signal);
    }
  }

  private async reconcile(
    sessionId: string,
    pending: Map<string, PendingAsk>,
    emit: (event: BackendEvent) => void,
  ): Promise<void> {
    const current = new Map<string, PendingAsk>();
    const permissions = rec(await this.request("GET", `/api/session/${sessionId}/permission`, { timeoutMs: 5000 }));
    for (const p of Array.isArray(permissions.data) ? permissions.data : []) {
      const ask = permissionAsk(rec(p));
      current.set(ask.id, ask);
    }
    const forms = rec(await this.request("GET", `/api/session/${sessionId}/form`, { timeoutMs: 5000 }));
    for (const f of Array.isArray(forms.data) ? forms.data : []) {
      const ask = formAsk(rec(f));
      current.set(ask.id, ask);
    }
    for (const id of [...pending.keys()]) {
      if (!current.has(id)) emit({ kind: "ask_resolved", id });
    }
    for (const [id, ask] of current) {
      if (!pending.has(id)) emit({ kind: "ask", ask });
    }
  }
}

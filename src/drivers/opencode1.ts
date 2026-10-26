// OpenCode 1.x backend (`opencode serve` 1.18.x + `@opencode-ai/sdk`).
//
// Verified against `@opencode-ai/sdk@1.18.30`'s shipped `.d.ts`:
// the client has no `session.chat` — the real send-message call is
// `session.prompt({ path: { id }, body: { parts } })`, `session.create`
// takes `{ body: { title }, query: { directory } }`, `session.abort` takes
// `{ path: { id } }`, and `event.subscribe()` resolves to `{ stream }` (an
// async generator), not an async-iterable response itself. Every event is
// `{ type, properties }` — session id lives inside `properties` (shape
// depends on event type: `properties.part.sessionID` for
// `message.part.updated`, `properties.info.sessionID` for `message.updated`,
// `properties.sessionID` elsewhere) — there is no top-level `event.sessionID`
// or `event.part` as an earlier draft of this file assumed.

import type { DriverEvent } from "../driver.js";
import { buildInlineConfig, confirmBashRules, missingConfirmRules } from "../policy.js";
import {
  type BackendEvent,
  type OpenCodeBackend,
  type PendingAsk,
  type TurnReply,
  basicAuthHeader,
  describeError,
  isApproval,
  retryFailure,
} from "./opencodeCommon.js";
import { apiFromSpecs } from "./opencodeVersion.js";

export interface OpenCodeBackendOptions {
  baseUrl: string;
  /** Sent as HTTP Basic (`opencode:<password>`) on every request when set. */
  password?: string;
}

export class OpenCodeV1Backend implements OpenCodeBackend {
  readonly api = "v1" as const;
  private client: OpenCodeSdkClient | null = null;

  constructor(private readonly options: OpenCodeBackendOptions) {}

  private headers(): Record<string, string> {
    return this.options.password ? { Authorization: basicAuthHeader(this.options.password) } : {};
  }

  private async sdk(): Promise<OpenCodeSdkClient> {
    if (this.client) return this.client;
    // @opencode-ai/sdk is an `optionalDependencies` entry (package.json) —
    // present in the common case (npm installs it), but this dynamic
    // import still degrades to an error the driver reports rather than
    // crashing the connector if it's genuinely missing (offline install, npm
    // --omit=optional, platform mismatch). Cast through `unknown` because
    // its type declarations are only relied on locally via
    // OpenCodeSdkModule below, never re-exported.
    const sdk = (await import("@opencode-ai/sdk")) as unknown as OpenCodeSdkModule;
    this.client = sdk.createOpencodeClient({ baseUrl: this.options.baseUrl, headers: this.headers() });
    return this.client;
  }

  async verifyApi(): Promise<void> {
    const res = await fetch(`${this.options.baseUrl}/doc`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
    const spec: unknown = res.ok ? await res.json().catch(() => null) : null;
    if (apiFromSpecs(null, spec) !== "v1") throw new Error("the server's /doc is not the OpenCode 1.x OpenAPI document");
  }

  inlineConfig(confirmOps: string[], existing?: string): string | null {
    return buildInlineConfig(confirmOps, existing)?.json ?? null;
  }

  // confirm_ops is a safety policy, so it fails closed: if the server did not
  // pick up the rules (an OpenCode version that ignores the inline config),
  // the task does not run.
  async verifyConfirmRules(confirmOps: string[]): Promise<void> {
    const res = await fetch(`${this.options.baseUrl}/config`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`GET /config answered ${res.status}`);
    const missing = missingConfirmRules(await res.json(), confirmBashRules(confirmOps));
    if (missing.length > 0) throw new Error(`rules not applied: ${missing.join(", ")}`);
  }

  async createSession(title: string, directory: string): Promise<string> {
    const client = await this.sdk();
    const created = await client.session.create({ body: { title }, query: { directory } });
    return unwrap(created).id;
  }

  async prompt(sessionId: string, text: string): Promise<TurnReply> {
    const client = await this.sdk();
    return unwrap(await client.session.prompt({ path: { id: sessionId }, body: { parts: [{ type: "text", text }] } }));
  }

  async say(sessionId: string, text: string): Promise<void> {
    const client = await this.sdk();
    await client.session.prompt({ path: { id: sessionId }, body: { parts: [{ type: "text", text }] } });
  }

  // A `permission.asked` is opencode's own confirm-before-run gate, driven by
  // the recipient's opencode.json `permission.*` config (see
  // connector/opencode.example.json). Verified live against opencode serve
  // 1.18.30: the event type is `permission.asked`, not `permission.updated`
  // (that type does not exist in this version's event catalog); the permission
  // object's fields are `permission` (a type string, e.g. "bash") and
  // `patterns` (array), not `title`/`pattern`. Replying goes through the
  // non-deprecated `POST /permission/{requestID}/reply` with
  // `{reply: "once"|"reject"}` — the SDK's `postSessionIdPermissionsPermissionId`
  // targets a `deprecated: true` endpoint implicated in a live crash, and the
  // generated client does not expose the new one, so this is a direct fetch.
  async answerAsk(_sessionId: string, ask: PendingAsk, text: string): Promise<void> {
    await fetch(`${this.options.baseUrl}/permission/${ask.id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify({ reply: isApproval(text) ? "once" : "reject" }),
    });
  }

  async events(sessionId: string, onEvent: (event: BackendEvent) => void): Promise<void> {
    const client = await this.sdk();
    const { stream } = await client.event.subscribe();
    for await (const event of stream) {
      const mapped = mapOpenCodeEvent(event as OpenCodeEvent, sessionId);
      if (!mapped) continue;
      if (mapped.kind === "permission") onEvent({ kind: "ask", ask: permissionAsk(mapped.permission) });
      else if (mapped.kind === "failed") onEvent(mapped);
      else onEvent({ kind: "driver", event: mapped.event });
    }
  }

  async abort(sessionId: string): Promise<void> {
    const client = await this.sdk();
    await client.session.abort({ path: { id: sessionId } });
  }
}

function permissionAsk(permission: OpenCodePermission): PendingAsk {
  const patterns = Array.isArray(permission.patterns) ? permission.patterns.join(", ") : "";
  const command = (permission.metadata as { command?: string } | undefined)?.command;
  const detail = command || patterns || permission.permission;
  return {
    id: permission.id,
    kind: "permission",
    content: `The local agent asks for confirmation (${permission.permission}): ${detail}`,
    options: ["Allow", "Deny"],
  };
}

/** Either a wire-ready {@link DriverEvent}, or opencode's own permission-gate
 * event (which the caller bridges into `ask_user`). */
export type OpenCodeMappedEvent =
  | { kind: "driver"; event: DriverEvent }
  | { kind: "permission"; permission: OpenCodePermission }
  | { kind: "failed"; message: string }
  | null;

// A pure function (same behaviour as the stream loop in `events`, just
// testable without a live `opencode serve` or SSE stream) so
// `test/driverStatusMapping.test.ts` can assert the status sequence for a task lifecycle.
export function mapOpenCodeEvent(event: OpenCodeEvent, sessionId: string): OpenCodeMappedEvent {
  const props = event.properties as Record<string, unknown> | undefined;
  switch (event.type) {
    case "message.part.updated": {
      const part = props?.part as OpenCodePart | undefined;
      if (!part || part.sessionID !== sessionId) return null;
      if (part.type === "tool") {
        const status = part.state?.status;
        return {
          kind: "driver",
          event: {
            kind: "status",
            status: status === "running" || status === "pending" ? "TOOL_CALL_STARTED" : "TOOL_CALL_FINISHED",
            detail: { tool: part.tool },
          },
        };
      }
      if (part.type === "text") {
        return { kind: "driver", event: { kind: "status", status: "LLM_HEARTBEAT" } };
      }
      if (part.type === "reasoning") {
        return { kind: "driver", event: { kind: "reasoning", content: part.text ?? "" } };
      }
      return null;
    }
    case "message.updated": {
      const info = props?.info as { sessionID?: string } | undefined;
      if (info?.sessionID !== sessionId) return null;
      return { kind: "driver", event: { kind: "status", status: "LLM_RESPONSE_RECEIVED" } };
    }
    case "session.idle": {
      if ((props?.sessionID as string | undefined) !== sessionId) return null;
      return { kind: "driver", event: { kind: "status", status: "WAITING_PEER" } };
    }
    // The model call failed (a usage limit, a bad key). The prompt request
    // does not return when this happens, so this event is the only place
    // the real reason shows up. An aborted message is our own Stop.
    case "session.error": {
      if ((props?.sessionID as string | undefined) !== sessionId) return null;
      const error = props?.error as { name?: string } | undefined;
      if (!error || error.name === "MessageAbortedError") return null;
      return { kind: "failed", message: describeError(error) };
    }
    case "session.status": {
      if ((props?.sessionID as string | undefined) !== sessionId) return null;
      const failure = retryFailure(props?.status);
      return failure?.kind === "failed" ? failure : null;
    }
    case "permission.asked": {
      const permission = props as unknown as OpenCodePermission;
      if (permission?.sessionID !== sessionId) return null;
      return { kind: "permission", permission };
    }
    default:
      return null;
  }
}

// ── Minimal shape of @opencode-ai/sdk this backend relies on, matching the
// shipped `.d.ts` for 1.18.30. Kept local (not `import type` from the
// package) so this file still type-checks even when the optional dependency
// isn't installed. ──────────────────────────────────────────────────────────
interface OpenCodeToolState {
  status: "pending" | "running" | "completed" | "error";
}
export interface OpenCodePart {
  sessionID: string;
  type: string;
  text?: string;
  tool?: string;
  state?: OpenCodeToolState;
}
export interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}
export interface OpenCodePermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
}
// SDK methods return `{ data, error, request, response }` when not using
// `throwOnError` — `unwrap` below picks `data` when present, otherwise
// treats the value as already the payload (covers either calling
// convention without committing this driver to one HeyAPI version's
// default).
function unwrap<T>(value: T | { data: T }): T {
  return (value as { data?: T }).data ?? (value as T);
}
interface OpenCodeSdkClient {
  session: {
    create(args: {
      body: { title: string };
      query?: { directory?: string };
    }): Promise<{ id: string } | { data: { id: string } }>;
    prompt(args: {
      path: { id: string };
      body: { parts: Array<{ type: string; text: string }> };
    }): Promise<TurnReply | { data: TurnReply }>;
    abort(args: { path: { id: string } }): Promise<unknown>;
  };
  event: {
    subscribe(): Promise<{ stream: AsyncIterable<OpenCodeEvent> }>;
  };
}
interface OpenCodeSdkModule {
  createOpencodeClient(args: { baseUrl: string; headers?: Record<string, string> }): OpenCodeSdkClient;
}

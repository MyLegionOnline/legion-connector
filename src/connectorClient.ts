// Wire-protocol client — hub/docs/connector_protocol.md. Owns the WS
// connection, frame envelope (seq/run_id/session_id), reconnect + resume,
// and translating between wire frames and one `AgentDriver` run per active
// session. Drivers never see a frame; the client never inspects local
// process state — that split is what keeps `test/dispatch.test.ts` able to
// exercise this file against a `MockDriver` with no real CLI agent involved.

import WebSocket from "ws";
import type { ConnectorConfig, ConnectorCredentials } from "./config.js";
import type { AgentDriver, DispatchContext, DriverEvent, DriverRun } from "./driver.js";
import { logger } from "./logger.js";
import { refreshAccessToken } from "./pairing.js";
import { resolveWorkDir } from "./policy.js";

// Modes this connector implements. A dispatch for any other mode is refused,
// whatever connector.toml lists: it cannot do what it was not built to do.
const SUPPORTED_MODES = ["operator"];

interface Frame {
  type: string;
  seq?: number | null;
  run_id?: string | null;
  session_id?: string | null;
  payload?: Record<string, unknown>;
}

interface ActiveRun {
  run_id: string;
  driverRun: DriverRun;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class ConnectorClient {
  private ws: WebSocket | null = null;
  private accessToken: string | null = null;
  private closing = false;
  private reconnectAttempt = 0;
  private lastAckedSeq: number | null = null;
  private readonly activeRuns = new Map<string, ActiveRun>(); // session_id -> run
  private readonly lastSeqBySession = new Map<string, number>();

  constructor(
    private readonly config: ConnectorConfig,
    private readonly credentials: ConnectorCredentials,
    private readonly driver: AgentDriver,
  ) {}

  async connect(): Promise<void> {
    this.closing = false;
    await this.reconnectLoop();
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
  }

  private async reconnectLoop(): Promise<void> {
    while (!this.closing) {
      try {
        this.accessToken = (
          await refreshAccessToken(this.config.hub_url, this.credentials.refresh_token)
        ).access_token;
        await this.openSocket(this.accessToken);
        this.reconnectAttempt = 0;
        return; // openSocket only resolves once the socket has closed cleanly
      } catch (err) {
        this.reconnectAttempt += 1;
        const delay = Math.min(
          RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
          RECONNECT_MAX_MS,
        );
        logger.warn("connector: reconnect failed, retrying", {
          error: String(err),
          delay_ms: delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private openSocket(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.config.hub_url}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      let helloSent = false;

      ws.on("open", () => {
        helloSent = true;
        this.send({
          type: "hello",
          payload: {
            connector_id: this.credentials.connector_id,
            version: "0.1.0",
            protocol_version: "2",
            capabilities: {
              agent_cli: this.config.agent_cli,
              cli_version: this.config.cli_version ?? null,
              opencode_api: this.config.cli_api ?? null,
              os: process.platform,
              modes: this.config.modes,
            },
          },
        });
        // Catch up any session we were mid-run on before the last drop.
        for (const [sessionId, lastSeq] of this.lastSeqBySession.entries()) {
          this.send({ type: "resume", payload: { session_id: sessionId, last_seq: lastSeq } });
        }
        logger.info("connector: connected", { hub_url: this.config.hub_url });
      });

      ws.on("message", (data) => {
        void this.handleFrame(data.toString());
      });

      ws.on("close", (code) => {
        logger.warn("connector: socket closed", { code });
        if (!helloSent) {
          reject(new Error(`socket closed before handshake (code=${code})`));
          return;
        }
        if (!this.closing) {
          void this.reconnectLoop();
        }
        resolve();
      });

      ws.on("error", (err) => {
        logger.error("connector: socket error", { error: String(err) });
      });
    });
  }

  private send(frame: Frame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private async handleFrame(raw: string): Promise<void> {
    let frame: Frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      logger.warn("connector: non-JSON frame from hub, dropping");
      return;
    }

    if (typeof frame.seq === "number" && frame.session_id) {
      this.lastSeqBySession.set(frame.session_id, frame.seq);
    }

    switch (frame.type) {
      case "ping":
        this.send({ type: "pong" });
        break;

      case "dispatch":
        await this.handleDispatch(frame);
        break;

      case "proxy_message":
      case "answer": {
        const run = frame.session_id ? this.activeRuns.get(frame.session_id) : undefined;
        if (run) {
          const content = (frame.payload?.content as string | undefined) ?? "";
          await run.driverRun.answer(content);
        }
        break;
      }

      case "stop": {
        const run = frame.session_id ? this.activeRuns.get(frame.session_id) : undefined;
        if (run) {
          const reason = (frame.payload?.reason as string | undefined) ?? "stop requested";
          await run.driverRun.stop(reason);
        }
        break;
      }

      case "pong":
        break;

      default:
        // A Hub newer than this connector may send a frame we cannot act on.
        // Staying silent leaves its task waiting for the dispatch timeout, so
        // say what happened. Only a frame tied to a run can be answered: the
        // Hub attributes `error` by run_id/session_id.
        logger.warn("connector: unknown frame type from hub", { type: frame.type });
        if (frame.session_id && frame.run_id) {
          this.send({
            type: "error",
            run_id: frame.run_id,
            session_id: frame.session_id,
            payload: {
              code: "unknown_frame",
              message: `this connector does not understand frame type "${String(frame.type)}"; update the connector`,
            },
          });
        }
    }

    if (typeof frame.seq === "number") {
      this.ackSeq(frame.seq);
    }
  }

  private ackSeq(seq: number): void {
    if (this.lastAckedSeq !== null && seq <= this.lastAckedSeq) return;
    this.lastAckedSeq = seq;
    this.send({ type: "ack", payload: { seq } });
  }

  private async handleDispatch(frame: Frame): Promise<void> {
    const payload = frame.payload ?? {};
    const sessionId = frame.session_id ?? (payload.session_id as string);
    const runId = frame.run_id ?? (payload.run_id as string);
    if (!sessionId || !runId) {
      this.send({
        type: "error",
        payload: { code: "malformed_dispatch", message: "dispatch missing session_id/run_id" },
      });
      return;
    }

    const ctx: DispatchContext = {
      task_id: payload.task_id as string,
      agent_id: payload.agent_id as string,
      room_id: payload.room_id as string,
      run_id: runId,
      session_id: sessionId,
      mode: (payload.mode as DispatchContext["mode"]) ?? "operator",
      task_data_text: (payload.task_data_text as string) ?? "",
      plan: payload.plan ?? null,
      agent_history_seed: (payload.agent_history_seed as unknown[]) ?? [],
      room_variables: (payload.room_variables as Record<string, string>) ?? {},
      cwd_hint: (payload.cwd_hint as string | null) ?? null,
    };

    logger.info("connector: dispatch received", { task_id: ctx.task_id, session_id: sessionId });

    // Local policy comes first. The mode must be one this connector implements
    // and the machine owner allows; the Hub only suggests a directory, and it is
    // honoured only inside the configured work_dirs.
    const requestedMode = String(payload.mode ?? "operator");
    if (!SUPPORTED_MODES.includes(requestedMode) || !(this.config.modes as string[]).includes(requestedMode)) {
      logger.warn("connector: dispatch refused, mode not supported", { mode: requestedMode, task_id: ctx.task_id });
      this.send({
        type: "error",
        run_id: runId,
        session_id: sessionId,
        payload: { code: "mode_not_supported", message: `this connector does not run mode=${requestedMode}` },
      });
      return;
    }

    const workDir = resolveWorkDir(this.config, ctx.cwd_hint);
    if (!workDir.ok) {
      logger.warn("connector: dispatch refused by local policy", { code: workDir.code, task_id: ctx.task_id });
      this.send({
        type: "error",
        run_id: runId,
        session_id: sessionId,
        payload: { code: workDir.code, message: workDir.message },
      });
      return;
    }
    ctx.cwd_hint = workDir.dir;

    const sink = (event: DriverEvent) => this.emitDriverEvent(sessionId, runId, event);

    try {
      const driverRun = await this.driver.start(ctx, sink);
      this.activeRuns.set(sessionId, { run_id: runId, driverRun });
    } catch (err) {
      this.send({
        type: "error",
        run_id: runId,
        session_id: sessionId,
        payload: { code: "driver_start_failed", message: String(err) },
      });
    }
  }

  private emitDriverEvent(sessionId: string, runId: string, event: DriverEvent): void {
    const envelope = { run_id: runId, session_id: sessionId };
    switch (event.kind) {
      case "status":
        this.send({ type: "status", ...envelope, payload: { status: event.status, detail: event.detail ?? {} } });
        break;
      case "reasoning":
        this.send({ type: "reasoning", ...envelope, payload: { content: event.content } });
        break;
      case "ask_cm":
        this.send({ type: "ask_cm", ...envelope, payload: { content: event.content } });
        break;
      case "ask_user":
        this.send({
          type: "ask_user",
          ...envelope,
          payload: { question_id: event.question_id, content: event.content, options: event.options },
        });
        break;
      case "result":
        this.send({ type: "result", ...envelope, payload: { ...event.result } });
        this.activeRuns.delete(sessionId);
        this.lastSeqBySession.delete(sessionId);
        break;
      case "error":
        this.send({ type: "error", ...envelope, payload: { code: event.code, message: event.message } });
        break;
    }
  }
}

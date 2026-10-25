// Acceptance criteria: "a test utility that sends a dispatch frame
// starts a session ... and receives a stream of status frames and a final result" plus
// "stop interrupts the local session within 5 seconds" and "a crash of the
// local agent -> an error frame, not silence". Exercised here against
// `MockDriver` (deterministic, no real CLI agent needed) so this proves the
// connectorClient/wire-protocol plumbing, independent of any one AgentDriver.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { ConnectorClient } from "../src/connectorClient.js";
import type { ConnectorConfig, ConnectorCredentials } from "../src/config.js";
import type { AgentDriver, DispatchContext, DriverEventSink, DriverRun } from "../src/driver.js";
import { MockDriver } from "../src/drivers/mock.js";

/** A slow-to-stop driver, for the 5s stop-bound test. */
class SlowStopDriver implements AgentDriver {
  readonly name = "slow-stop";
  async start(_ctx: DispatchContext, sink: DriverEventSink): Promise<DriverRun> {
    sink({ kind: "status", status: "LLM_REQUEST_SENT" });
    return {
      answer: async () => {},
      stop: async () => {
        await new Promise((r) => setTimeout(r, 50)); // "stops promptly" — well under 5s
      },
    };
  }
}

class CrashingDriver implements AgentDriver {
  readonly name = "crashing";
  async start(): Promise<DriverRun> {
    throw new Error("simulated local agent crash");
  }
}

interface HarnessServer {
  wss: WebSocketServer;
  port: number;
  received: Array<Record<string, unknown>>;
  socket: Promise<WebSocket>;
}

function startFakeHub(): HarnessServer {
  const wss = new WebSocketServer({ port: 0 });
  const received: Array<Record<string, unknown>> = [];
  let resolveSocket!: (ws: WebSocket) => void;
  const socket = new Promise<WebSocket>((resolve) => {
    resolveSocket = resolve;
  });
  wss.on("connection", (ws) => {
    resolveSocket(ws);
    ws.on("message", (data) => {
      received.push(JSON.parse(data.toString()));
    });
  });
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { wss, port, received, socket };
}

function fakeConfig(port: number): ConnectorConfig {
  return {
    hub_url: `ws://127.0.0.1:${port}`,
    agent_cli: "opencode",
    work_dirs: [],
    confirm_ops: [],
    modes: ["operator"],
  };
}

function fakeCredentials(): ConnectorCredentials {
  return { connector_id: randomUUID(), refresh_token: "unused-in-test", host_fingerprint: "test" };
}

// The client normally exchanges refresh_token -> access_token via REST
// (pairing.ts). These tests talk directly to a raw WS server, so we monkey-
// patch fetch to satisfy that call without standing up the FastAPI app.
function stubTokenEndpoint(): void {
  const realFetch = global.fetch;
  global.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/connectors/token")) {
      return new Response(JSON.stringify({ access_token: "test-token", token_type: "bearer", expires_in: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, init);
  }) as typeof fetch;
}

before(() => {
  stubTokenEndpoint();
});

function waitFor(
  received: Array<Record<string, unknown>>,
  predicate: (f: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const found = received.find(predicate);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error("timed out waiting for frame"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("dispatch produces a status stream and a final result", async () => {
  const hub = startFakeHub();
  const client = new ConnectorClient(fakeConfig(hub.port), fakeCredentials(), new MockDriver());
  void client.connect();
  const ws = await hub.socket;

  await waitFor(hub.received, (f) => f.type === "hello");

  const sessionId = randomUUID();
  const runId = randomUUID();
  ws.send(
    JSON.stringify({
      type: "dispatch",
      seq: 1,
      run_id: runId,
      session_id: sessionId,
      payload: {
        task_id: randomUUID(),
        agent_id: randomUUID(),
        room_id: randomUUID(),
        mode: "operator",
        task_data_text: "deploy main to prod",
        room_variables: {},
        cwd_hint: null,
      },
    }),
  );

  await waitFor(hub.received, (f) => f.type === "ack" && (f.payload as any)?.seq === 1);
  const statusFrames = await waitFor(hub.received, (f) => f.type === "status");
  assert.equal(statusFrames.run_id, runId);
  assert.equal(statusFrames.session_id, sessionId);

  const result = await waitFor(hub.received, (f) => f.type === "result");
  assert.equal((result.payload as any).status, "success");
  assert.match((result.payload as any).summary, /deploy main to prod/);

  client.close();
  hub.wss.close();
});

test("stop settles within 5 seconds", async () => {
  const hub = startFakeHub();
  const client = new ConnectorClient(fakeConfig(hub.port), fakeCredentials(), new SlowStopDriver());
  void client.connect();
  const ws = await hub.socket;
  await waitFor(hub.received, (f) => f.type === "hello");

  const sessionId = randomUUID();
  const runId = randomUUID();
  ws.send(
    JSON.stringify({
      type: "dispatch",
      seq: 1,
      run_id: runId,
      session_id: sessionId,
      payload: { task_id: randomUUID(), agent_id: randomUUID(), room_id: randomUUID(), task_data_text: "x" },
    }),
  );
  await waitFor(hub.received, (f) => f.type === "status");

  const start = Date.now();
  ws.send(
    JSON.stringify({
      type: "stop",
      seq: 2,
      run_id: runId,
      session_id: sessionId,
      payload: { reason: "user cancelled" },
    }),
  );
  // The client only acks seq=2 once `driverRun.stop()` has resolved (they're
  // awaited in sequence in connectorClient.handleFrame), so this ack is a
  // faithful proxy for "the local session actually stopped".
  await waitFor(hub.received, (f) => f.type === "ack" && (f.payload as any)?.seq === 2, 6000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `stop took ${elapsed}ms, expected < 5000ms`);

  client.close();
  hub.wss.close();
});

test("a driver crash surfaces as an error frame, not silence", async () => {
  const hub = startFakeHub();
  const client = new ConnectorClient(fakeConfig(hub.port), fakeCredentials(), new CrashingDriver());
  void client.connect();
  const ws = await hub.socket;
  await waitFor(hub.received, (f) => f.type === "hello");

  const sessionId = randomUUID();
  const runId = randomUUID();
  ws.send(
    JSON.stringify({
      type: "dispatch",
      seq: 1,
      run_id: runId,
      session_id: sessionId,
      payload: { task_id: randomUUID(), agent_id: randomUUID(), room_id: randomUUID(), task_data_text: "x" },
    }),
  );

  const errorFrame = await waitFor(hub.received, (f) => f.type === "error");
  assert.equal((errorFrame.payload as any).code, "driver_start_failed");

  client.close();
  hub.wss.close();
});

test("hello announces the protocol version and modes", async () => {
  const hub = startFakeHub();
  const client = new ConnectorClient(fakeConfig(hub.port), fakeCredentials(), new MockDriver());
  void client.connect();
  await hub.socket;

  const hello = await waitFor(hub.received, (f) => f.type === "hello");
  assert.equal((hello.payload as any).protocol_version, "2");
  assert.deepEqual((hello.payload as any).capabilities.modes, ["operator"]);

  client.close();
  hub.wss.close();
});

test("a frame of an unknown type for a run is answered with error unknown_frame", async () => {
  const hub = startFakeHub();
  const client = new ConnectorClient(fakeConfig(hub.port), fakeCredentials(), new MockDriver());
  void client.connect();
  const ws = await hub.socket;
  await waitFor(hub.received, (f) => f.type === "hello");

  const sessionId = randomUUID();
  const runId = randomUUID();
  ws.send(
    JSON.stringify({ type: "from_the_future", seq: 1, run_id: runId, session_id: sessionId, payload: {} }),
  );

  const errorFrame = await waitFor(hub.received, (f) => f.type === "error");
  assert.equal(errorFrame.run_id, runId);
  assert.equal(errorFrame.session_id, sessionId);
  assert.equal((errorFrame.payload as any).code, "unknown_frame");
  // The frame is still acked so the Hub does not redeliver it forever.
  await waitFor(hub.received, (f) => f.type === "ack" && (f.payload as any)?.seq === 1);

  client.close();
  hub.wss.close();
});

test("a pong is not an unknown frame", async () => {
  const hub = startFakeHub();
  const client = new ConnectorClient(fakeConfig(hub.port), fakeCredentials(), new MockDriver());
  void client.connect();
  const ws = await hub.socket;
  await waitFor(hub.received, (f) => f.type === "hello");

  ws.send(JSON.stringify({ type: "pong", run_id: randomUUID(), session_id: randomUUID() }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(hub.received.some((f) => f.type === "error"), false);

  client.close();
  hub.wss.close();
});

after(() => {
  // node:test keeps the process alive if a WS client/server is left open —
  // both are explicitly closed at the end of every test above.
});

class RecordingDriver implements AgentDriver {
  readonly name = "recording";
  contexts: DispatchContext[] = [];
  async start(ctx: DispatchContext, sink: DriverEventSink): Promise<DriverRun> {
    this.contexts.push(ctx);
    sink({
      kind: "result",
      result: { status: "success", summary: "ok", artifacts: [], usage: { tokens: null, cost_usd: null } },
    });
    return { answer: async () => {}, stop: async () => {} };
  }
}

async function dispatchWith(workDirs: string[], cwdHint: string | null, driver: AgentDriver) {
  const hub = startFakeHub();
  const client = new ConnectorClient({ ...fakeConfig(hub.port), work_dirs: workDirs }, fakeCredentials(), driver);
  void client.connect();
  const ws = await hub.socket;
  await waitFor(hub.received, (f) => f.type === "hello");
  ws.send(
    JSON.stringify({
      type: "dispatch",
      seq: 1,
      run_id: randomUUID(),
      session_id: randomUUID(),
      payload: {
        task_id: randomUUID(),
        agent_id: randomUUID(),
        room_id: randomUUID(),
        mode: "operator",
        task_data_text: "x",
        cwd_hint: cwdHint,
      },
    }),
  );
  return { hub, client };
}

test("a cwd_hint outside work_dirs is refused and the driver is never started", async () => {
  const allowed = path.resolve("/srv/apps/landing");
  const driver = new RecordingDriver();
  const { hub, client } = await dispatchWith([allowed], path.resolve("/etc"), driver);
  const error = await waitFor(hub.received, (f) => f.type === "error");
  assert.equal((error.payload as any).code, "cwd_not_allowed");
  assert.equal(driver.contexts.length, 0);
  client.close();
  hub.wss.close();
});

test("without a cwd_hint the first work_dir becomes the working directory", async () => {
  const first = path.resolve("/srv/apps/landing");
  const driver = new RecordingDriver();
  const { hub, client } = await dispatchWith([first, path.resolve("/srv/apps/other")], null, driver);
  await waitFor(hub.received, (f) => f.type === "result");
  assert.equal(driver.contexts[0].cwd_hint, first);
  client.close();
  hub.wss.close();
});

test("a dispatch for a mode the connector does not run is refused and the driver is never started", async () => {
  const driver = new RecordingDriver();
  const hub = startFakeHub();
  const client = new ConnectorClient(fakeConfig(hub.port), fakeCredentials(), driver);
  void client.connect();
  const ws = await hub.socket;
  await waitFor(hub.received, (f) => f.type === "hello");
  ws.send(
    JSON.stringify({
      type: "dispatch",
      seq: 1,
      run_id: randomUUID(),
      session_id: randomUUID(),
      payload: {
        task_id: randomUUID(),
        agent_id: randomUUID(),
        room_id: randomUUID(),
        mode: "worker",
        task_data_text: "x",
        workspace_archive_b64: "AAAA",
      },
    }),
  );
  const error = await waitFor(hub.received, (f) => f.type === "error");
  assert.equal((error.payload as any).code, "mode_not_supported");
  assert.equal(driver.contexts.length, 0);
  client.close();
  hub.wss.close();
});

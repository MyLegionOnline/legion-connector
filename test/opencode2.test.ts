// The OpenCode 2.x backend. The pure parts (event mapping, SSE framing, reply
// assembly, route check) are tested directly; the rest runs against a small
// fake server that speaks the routes of `fixtures/opencode-v2-routes.json`
// (cut from the live spec), so the HTTP, auth and event-driven turn handling
// are exercised without an OpenCode install.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { AgentStatusName, DriverEvent } from "../src/driver.js";
import type { BackendEvent } from "../src/drivers/opencodeCommon.js";
import {
  OpenCodeV2Backend,
  SseParser,
  mapOpenCodeV2Event,
  missingRoutes,
  replyFromMessages,
  type V2Frame,
} from "../src/drivers/opencode2.js";
import { outcomeOf } from "../src/drivers/opencodeCommon.js";

const SID = "ses_1";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/opencode-v2-routes.json", import.meta.url), "utf8"));

function frames(...list: Array<[type: string, data: Record<string, unknown>]>): V2Frame[] {
  return list.map(([type, data]) => ({ type, data }));
}

function mapAll(list: V2Frame[]): BackendEvent[] {
  const names = new Map<string, string>();
  return list.map((f) => mapOpenCodeV2Event(f, SID, names)).filter((e): e is BackendEvent => e !== null);
}

function driverEvents(events: BackendEvent[]): DriverEvent[] {
  return events.flatMap((e) => (e.kind === "driver" ? [e.event] : []));
}

test("a tool call followed by an answer maps to the expected status sequence", () => {
  const events = driverEvents(
    mapAll(
      frames(
        ["session.step.started", { sessionID: SID }],
        ["session.tool.input.started", { sessionID: SID, id: "call1", name: "bash" }],
        ["session.tool.called", { sessionID: SID, id: "call1" }],
        ["session.tool.success", { sessionID: SID, id: "call1" }],
        ["session.step.ended", { sessionID: SID }],
        ["session.status", { sessionID: SID, status: { type: "idle" } }],
      ),
    ),
  );
  const statuses = events.flatMap((e) => (e.kind === "status" ? [e.status] : []));
  assert.deepEqual(statuses satisfies AgentStatusName[], [
    "LLM_REQUEST_SENT",
    "TOOL_CALL_STARTED",
    "TOOL_CALL_FINISHED",
    "LLM_RESPONSE_RECEIVED",
    "WAITING_PEER",
  ]);
  const finished = events.find((e) => e.kind === "status" && e.status === "TOOL_CALL_FINISHED");
  assert.deepEqual(finished?.kind === "status" && finished.detail, { tool: "bash" });
});

test("provider retries end the run only once the retry cap is reached", () => {
  const retry = (attempt: number) =>
    mapAll(frames(["session.status", { sessionID: SID, status: { type: "retry", attempt, message: "Rate limited", next: 0 } }]));
  assert.deepEqual(retry(1), [{ kind: "driver", event: { kind: "status", status: "LLM_HEARTBEAT" } }]);
  assert.deepEqual(retry(3), [{ kind: "failed", message: "The model provider keeps failing (attempt 3): Rate limited" }]);
});

test("reasoning is reported once, as the finished text", () => {
  const events = driverEvents(
    mapAll(
      frames(
        ["session.reasoning.delta", { sessionID: SID, delta: "thin" }],
        ["session.reasoning.ended", { sessionID: SID, text: "thinking it through" }],
      ),
    ),
  );
  assert.deepEqual(events, [
    { kind: "status", status: "LLM_HEARTBEAT" },
    { kind: "reasoning", content: "thinking it through" },
  ]);
});

test("events of another session are ignored", () => {
  assert.deepEqual(mapAll(frames(["session.step.started", { sessionID: "other" }])), []);
  assert.deepEqual(mapAll(frames(["form.created", { form: { id: "f", sessionID: "other", title: "?", fields: [] } }])), []);
});

test("a permission request becomes a confirmation card, and its reply withdraws it", () => {
  const [asked, replied] = mapAll(
    frames(
      ["permission.asked", { id: "per_1", sessionID: SID, action: "shell", resources: ["systemctl reload nginx"] }],
      ["permission.replied", { id: "per_1", sessionID: SID }],
    ),
  );
  assert.equal(asked?.kind, "ask");
  if (asked?.kind === "ask") {
    assert.equal(asked.ask.id, "per_1");
    assert.deepEqual(asked.ask.options, ["Allow", "Deny"]);
    assert.match(asked.ask.content, /shell.*systemctl reload nginx/);
  }
  assert.deepEqual(replied, { kind: "ask_resolved", id: "per_1" });
});

test("a form with a choice offers its options", () => {
  const [asked] = mapAll(
    frames([
      "form.created",
      {
        form: {
          id: "frm_1",
          sessionID: SID,
          title: "Which environment?",
          fields: [{ key: "env", type: "string", options: [{ value: "stg", label: "Staging" }, { value: "prod", label: "Production" }] }],
        },
      },
    ]),
  );
  assert.equal(asked?.kind, "ask");
  if (asked?.kind === "ask") {
    assert.equal(asked.ask.kind, "form");
    assert.deepEqual(asked.ask.options, ["Staging", "Production"]);
  }
});

test("the SSE parser yields data payloads across chunk boundaries and skips heartbeats", () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: {"a":1}\n\n: heartbeat\n\ndata: {"b"'), ['{"a":1}']);
  assert.deepEqual(p.push(':2}\r\n\r\n'), ['{"b":2}']);
});

test("the reply is what follows the last user message, and a failed loop is an error", () => {
  const ok = replyFromMessages([
    { type: "user" },
    { type: "assistant", content: [{ type: "tool" }], cost: 0.01, tokens: { input: 10, output: 2 } },
    {
      type: "assistant",
      content: [{ type: "reasoning", text: "hm" }, { type: "text", text: "Done: 1) edited 2) reloaded" }],
      model: { id: "m", providerID: "p" },
      cost: 0.02,
      tokens: { input: 20, output: 5 },
    },
    { type: "idle", outcome: "succeeded" },
  ]);
  assert.equal(outcomeOf(ok).summary, "Done: 1) edited 2) reloaded");
  assert.equal(ok.info.tokens?.output, 7);
  assert.equal(ok.info.modelID, "m");

  const toolOnly = replyFromMessages([
    { type: "user" },
    { type: "assistant", content: [{ type: "tool" }] },
    { type: "assistant", content: [] },
    { type: "idle", outcome: "succeeded" },
  ]);
  assert.equal(outcomeOf(toolOnly).empty, false);

  const empty = replyFromMessages([{ type: "user" }, { type: "assistant", content: [], tokens: { input: 5, output: 6 } }, { type: "idle", outcome: "succeeded" }]);
  assert.equal(outcomeOf(empty).empty, true);

  const failed = replyFromMessages([
    { type: "user" },
    { type: "assistant", content: [] },
    { type: "idle", outcome: "failed", error: { type: "ProviderAuthError", message: "bad key" } },
  ]);
  const o = outcomeOf(failed);
  assert.equal(o.failed, true);
  assert.match(o.summary, /ProviderAuthError: bad key/);

  const stopped = replyFromMessages([{ type: "user" }, { type: "idle", outcome: "interrupted" }]);
  assert.match(outcomeOf(stopped).summary, /interrupted/);
});

test("every route the backend calls exists in the recorded spec, and a gap is named", () => {
  assert.deepEqual(missingRoutes(fixture), []);
  const broken = structuredClone(fixture);
  delete broken.paths["/api/session/{sessionID}/interrupt"].post;
  assert.deepEqual(missingRoutes(broken), ["POST /api/session/{sessionID}/interrupt"]);
});

// ── against a fake server ────────────────────────────────────────────────────

const PASSWORD = "s3cret";
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;

interface Fake {
  url: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  /** Push an SSE frame to every connected event stream. */
  emit(type: string, data: Record<string, unknown>): void;
  messages: unknown[];
  location: string;
  close(): Promise<void>;
}

async function fakeServer(): Promise<Fake> {
  const streams = new Set<ServerResponse>();
  const requests: Fake["requests"] = [];
  const fake: Fake = {
    url: "",
    requests,
    messages: [],
    location: process.cwd(),
    emit(type, data) {
      for (const s of streams) s.write(`data: ${JSON.stringify({ id: "evt", type, data })}\n\n`);
    },
    close: async () => {
      for (const s of streams) s.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] as string;
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? "", path, body });
      const json = (value: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== AUTH) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ _tag: "UnauthorizedError" }));
        return;
      }
      if (path === "/openapi.json") return json(fixture);
      if (path === "/api/event") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(': heartbeat\n\n');
        streams.add(res);
        res.on("close", () => streams.delete(res));
        return;
      }
      if (path === "/api/session" && req.method === "POST") {
        return json({ data: { id: SID, location: { directory: fake.location } } });
      }
      if (path === `/api/session/${SID}/prompt`) {
        json({ data: { id: "msg_1", type: "user" } });
        // The model "works" for a moment, then the loop ends.
        setTimeout(() => {
          fake.messages = [
            { type: "idle", outcome: "succeeded" },
            { type: "assistant", content: [{ type: "text", text: "all done" }], cost: 0.5, tokens: { input: 3, output: 4 } },
            { type: "user" },
          ];
          fake.emit("session.execution.succeeded", { sessionID: SID });
        }, 100);
        return;
      }
      if (path === `/api/session/${SID}/message`) return json({ data: fake.messages, cursor: {} });
      if (path === `/api/session/${SID}/permission/per_1/reply`) {
        res.writeHead(204);
        return void res.end();
      }
      if (path === `/api/session/${SID}/interrupt`) return json({ interrupted: true });
      if (path === "/api/session/active") return json({ data: {} });
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

const open: Fake[] = [];
after(async () => {
  for (const f of open) await f.close();
});

test("a whole turn: session in the right directory, prompt, events, reply, confirmation", async () => {
  const fake = await fakeServer();
  open.push(fake);
  const backend = new OpenCodeV2Backend({ baseUrl: fake.url, password: PASSWORD });

  await backend.verifyApi();
  const sessionId = await backend.createSession("legion-task-1", fake.location);
  assert.equal(sessionId, SID);
  const create = fake.requests.find((r) => r.method === "POST" && r.path === "/api/session");
  assert.deepEqual((create?.body as { location?: unknown }).location, { directory: fake.location });

  const seen: BackendEvent[] = [];
  const stop = new AbortController();
  const pump = backend.events(SID, (e) => seen.push(e), stop.signal);
  await new Promise((r) => setTimeout(r, 100)); // let the stream connect

  fake.emit("permission.asked", { id: "per_1", sessionID: SID, action: "shell", resources: ["systemctl reload nginx"] });
  const reply = await backend.prompt(SID, "reload nginx");
  assert.equal(outcomeOf(reply).summary, "all done");
  assert.equal(reply.info.cost, 0.5);

  const ask = seen.find((e) => e.kind === "ask");
  assert.ok(ask && ask.kind === "ask", "the confirmation reached the driver");
  await backend.answerAsk(SID, ask.ask, "Allow");
  const answered = fake.requests.find((r) => r.path === `/api/session/${SID}/permission/per_1/reply`);
  assert.deepEqual(answered?.body, { decision: "once" });

  await backend.abort(SID);
  stop.abort();
  await pump;
});

test("a session created somewhere else than asked is refused", async () => {
  const fake = await fakeServer();
  open.push(fake);
  fake.location = "/somewhere/else";
  const backend = new OpenCodeV2Backend({ baseUrl: fake.url, password: PASSWORD });
  await assert.rejects(backend.createSession("t", "/srv/site"), /not in \/srv\/site/);
});

test("a wrong password never gets past the server", async () => {
  const fake = await fakeServer();
  open.push(fake);
  const backend = new OpenCodeV2Backend({ baseUrl: fake.url, password: "wrong" });
  await assert.rejects(backend.verifyApi(), /401/);
});

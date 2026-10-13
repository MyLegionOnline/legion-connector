// AgentDriver — one local CLI agent (OpenCode, …) wrapped behind a headless,
// structured-event interface so the connector never has to scrape a PTY to
// know "a tool was called" or "a question was asked".
//
// A driver never talks to the Hub directly — connectorClient.ts is the only
// thing that knows about frames/seq/run_id. That keeps every driver testable
// with nothing but a DispatchContext and an event sink.

export type Mode = "operator";

export interface DispatchContext {
  task_id: string;
  agent_id: string;
  room_id: string;
  run_id: string;
  session_id: string;
  mode: Mode;
  task_data_text: string;
  plan: unknown;
  agent_history_seed: unknown[];
  room_variables: Record<string, string>;
  cwd_hint: string | null;
}

// Mirrors the `AgentStatus` enum on the Hub side (core/events.py) — the
// mapping table is documented in the protocol. The driver only ever needs to name the
// *local* half of that table; connectorClient owns turning these into wire
// `status` frames.
export type AgentStatusName =
  | "LLM_REQUEST_SENT"
  | "LLM_HEARTBEAT"
  | "LLM_RESPONSE_RECEIVED"
  | "TOOL_CALL_STARTED"
  | "TOOL_CALL_FINISHED"
  | "WAITING_PEER";

export interface DriverResult {
  status: "success" | "failure";
  summary: string;
  artifacts: Array<{ name: string; kind: "log" | "file"; content_ref: string }>;
  usage: { tokens: number | null; cost_usd: number | null };
}

export type DriverEvent =
  | { kind: "status"; status: AgentStatusName; detail?: Record<string, unknown> }
  | { kind: "reasoning"; content: string }
  | { kind: "ask_cm"; content: string }
  | { kind: "ask_user"; question_id: string; content: string; options: string[] }
  | { kind: "result"; result: DriverResult }
  | { kind: "error"; code: string; message: string };

export type DriverEventSink = (event: DriverEvent) => void;

/** One in-flight dispatch — returned by `AgentDriver.start`. */
export interface DriverRun {
  /** Deliver a reply from the ChatMaster or the human into the local session. */
  answer(text: string): Promise<void>;
  /** Stop the local session. Must settle (resolve, and emit `result`/`error`) within 5s. */
  stop(reason: string): Promise<void>;
}

export interface AgentDriver {
  readonly name: string;
  start(ctx: DispatchContext, sink: DriverEventSink): Promise<DriverRun>;
}

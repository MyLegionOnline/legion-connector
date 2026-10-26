// What the two OpenCode API generations (1.x and 2.x) have in common: the
// backend interface the driver talks to, and the pure helpers that judge a
// finished turn. Neither backend knows about frames or the Hub; the driver in
// opencode.ts owns the process, the dispatch lifecycle and the events sink.

import type { DriverEvent } from "../driver.js";

export type OpenCodeApi = "v1" | "v2";

/** A question the local agent put to the human, waiting for an answer. */
export interface PendingAsk {
  /** OpenCode's own id (permission request or form). */
  id: string;
  kind: "permission" | "form";
  content: string;
  options: string[];
  /** Backend-specific payload needed to answer (e.g. the form's fields). */
  raw?: unknown;
}

export type BackendEvent =
  | { kind: "driver"; event: DriverEvent }
  | { kind: "ask"; ask: PendingAsk }
  /** The question was answered or withdrawn elsewhere (local terminal, timeout). */
  | { kind: "ask_resolved"; id: string }
  /** The model call failed for good (provider error, exhausted retries): end the run with this message. */
  | { kind: "failed"; message: string };

/**
 * How many times OpenCode may retry the model provider before the run is
 * failed. OpenCode keeps retrying an error it considers retryable (a usage
 * limit, an overloaded provider) while the prompt request just waits, so
 * without a cap the Hub only learned of it when that request timed out.
 */
export const MAX_PROVIDER_RETRIES = 3;

/**
 * A retry scheduled further out than this is not a hiccup: a free tier
 * limit, for one, is retried when the limit resets, hours later.
 */
export const MAX_RETRY_WAIT_MS = 2 * 60_000;

/**
 * The `failed` event for a `session.status` retry: once {@link MAX_PROVIDER_RETRIES}
 * is reached, or when the next attempt is more than {@link MAX_RETRY_WAIT_MS} away.
 */
export function retryFailure(status: unknown, now: number = Date.now()): BackendEvent | null {
  if (!status || typeof status !== "object") return null;
  const { type, attempt, message, next, action } = status as {
    type?: string;
    attempt?: number;
    message?: string;
    next?: number;
    action?: { message?: string };
  };
  if (type !== "retry" || typeof attempt !== "number") return null;
  const waitsTooLong = typeof next === "number" && next - now > MAX_RETRY_WAIT_MS;
  if (attempt < MAX_PROVIDER_RETRIES && !waitsTooLong) return null;
  const reason = [message, action?.message].filter(Boolean).join(" ") || "no details";
  return { kind: "failed", message: `The model provider keeps failing (attempt ${attempt}): ${reason}` };
}

/** The finished turn, in the shape {@link outcomeOf} judges. Both APIs are normalised to it. */
export interface TurnReply {
  info: {
    error?: unknown;
    cost?: number;
    tokens?: { input: number; output: number };
    providerID?: string;
    modelID?: string;
  };
  parts: Array<{ type: string; text?: string }>;
}

export interface OpenCodeBackend {
  readonly api: OpenCodeApi;
  /** Throws unless the running server really speaks this API (and offers every route the driver uses). */
  verifyApi(): Promise<void>;
  /** The inline config (`OPENCODE_CONFIG_CONTENT`) that carries the confirm_ops rules, or null when there are none. */
  inlineConfig(confirmOps: string[], existing?: string): string | null;
  /** Throws unless the confirm_ops rules from {@link inlineConfig} are in the server's effective config. */
  verifyConfirmRules(confirmOps: string[]): Promise<void>;
  createSession(title: string, directory: string): Promise<string>;
  /** Send a prompt and resolve with the reply once the model's turn is over. */
  prompt(sessionId: string, text: string): Promise<TurnReply>;
  /** A message from the human or ChatMaster in the middle of the run. */
  say(sessionId: string, text: string): Promise<void>;
  /** Deliver the human's answer to a question raised through a `PendingAsk`. */
  answerAsk(sessionId: string, ask: PendingAsk, text: string): Promise<void>;
  /** Pump native events as backend events until `signal` aborts; throws if the stream cannot be kept. */
  events(sessionId: string, onEvent: (event: BackendEvent) => void, signal: AbortSignal): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

/** Did the human say yes to a confirmation card? Matches the option labels the driver itself offers. */
export function isApproval(text: string): boolean {
  return /allow|once|continue/i.test(text);
}

// An error object is one of a handful of named shapes, all with
// `{ name, data: { message? } }` — `String(error)` on the raw object gives
// the useless "[object Object]" this pulls the real message out of instead.
export function describeError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const { name, data } = error as { name?: string; data?: { message?: string } };
  const message = data?.message;
  return [name, message].filter(Boolean).join(": ") || JSON.stringify(error);
}

/** Sent once, in the same session, when the model's reply had no text and no tool call. */
export const EMPTY_REPLY_NUDGE =
  "Your last reply was empty. Carry out the task now and finish with the final report.";

/** What a finished turn amounts to. `empty` means the model
 * said nothing and called no tool, i.e. nothing was done — not a result. */
export function outcomeOf(response: TurnReply): {
  empty: boolean;
  failed: boolean;
  summary: string;
  model: string | undefined;
} {
  const info = response.info;
  const text = extractText(response.parts);
  const model = info?.providerID && info?.modelID ? `${info.providerID}/${info.modelID}` : info?.modelID;
  if (info?.error) return { empty: false, failed: true, summary: text || describeError(info.error), model };
  if (text) return { empty: false, failed: false, summary: text, model };
  // A reply that only called tools has no text yet and is not empty: the turn
  // resolves with the *last* message, so a trailing tool-only message still
  // means the model did something.
  const calledTool = (response.parts ?? []).some((p) => p.type === "tool");
  if (calledTool) return { empty: false, failed: false, summary: "(the agent finished without a written report)", model };
  const out = info?.tokens?.output;
  return {
    empty: true,
    failed: true,
    summary:
      `The local agent returned an empty reply${model ? ` (model ${model}` : " ("}` +
      `${out !== undefined ? `, ${out} output tokens` : ""}, no text, no tool call) — nothing was done.`,
    model,
  };
}

function extractText(parts: Array<{ type: string; text?: string }>): string {
  return (parts ?? [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
    .trim();
}

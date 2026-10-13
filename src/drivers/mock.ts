// Deterministic driver used by the connector's own transport tests and by
// anyone wiring up a new Hub-side integration without a real OpenCode
// install running. Implements the exact same `AgentDriver` contract as
// `OpenCodeDriver`, so a test exercising this proves the connectorClient/
// wire-protocol plumbing independently of any one CLI agent's quirks.

import type { AgentDriver, DispatchContext, DriverEventSink, DriverRun } from "../driver.js";

export class MockDriver implements AgentDriver {
  readonly name = "mock";
  public stopped = false;
  public lastAnswer: string | null = null;

  async start(ctx: DispatchContext, sink: DriverEventSink): Promise<DriverRun> {
    sink({ kind: "status", status: "LLM_REQUEST_SENT" });
    sink({ kind: "status", status: "TOOL_CALL_STARTED", detail: { tool: "bash" } });
    sink({ kind: "status", status: "TOOL_CALL_FINISHED", detail: { tool: "bash" } });
    sink({ kind: "status", status: "LLM_RESPONSE_RECEIVED" });
    sink({
      kind: "result",
      result: {
        status: "success",
        summary: `mock: handled "${ctx.task_data_text}"`,
        artifacts: [],
        usage: { tokens: null, cost_usd: null },
      },
    });

    return {
      answer: async (text: string) => {
        this.lastAnswer = text;
      },
      stop: async () => {
        this.stopped = true;
      },
    };
  }
}

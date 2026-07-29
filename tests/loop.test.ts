import { describe, expect, it, vi } from "vitest";
import {
  runAgentLoop,
  INCOMPLETE_COPY,
  CONTEXT_TOO_LONG_COPY,
  type AgentTools,
  type ChatMessage,
  type ModelChunk,
  type RunAgentLoopParams,
  type ToolCallRequest,
} from "@/lib/agent/loop";
import type { NormalizedUsage } from "@/lib/agent/adapter";
import { OPENROUTER_FREE_FALLBACK } from "@/lib/registry";

const BUDGET_COPY = "ran out of compute time (i)";

const USAGE: NormalizedUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

interface Turn {
  deltas?: string[];
  usage?: NormalizedUsage;
  toolCalls?: ToolCallRequest[];
  stopReason?: string;
  throwAt?: "before" | "after";
}

/** Scripted model. Records the messages passed to each call; the LAST turn
 *  repeats forever (so an always-tool turn drives the 12-iteration cap). */
function scriptedModel(turns: Turn[]) {
  const calls: ChatMessage[][] = [];
  let i = 0;
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *run(messages: ChatMessage[]): AsyncGenerator<ModelChunk> {
      calls.push(messages.map((m) => ({ ...m })));
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      if (turn.throwAt === "before") throw new Error("PROVIDER_RAW_401_BODY");
      for (const d of turn.deltas ?? []) yield { delta: d };
      if (turn.throwAt === "after") throw new Error("PROVIDER_RAW_500_BODY");
      if (turn.toolCalls && turn.toolCalls.length > 0) yield { toolCalls: turn.toolCalls };
      if (turn.usage) yield { usage: turn.usage, stopReason: turn.stopReason };
      else if (turn.stopReason) yield { stopReason: turn.stopReason };
    },
  };
}

function fakeDb() {
  const calls = {
    updateMessageContent: [] as { id: string; content: string }[],
    markFirstModelCall: [] as string[],
    setRunStatus: [] as { runId: string; status: string; iterations?: number }[],
    insertUsageEvent: [] as unknown[],
    refundRun: [] as string[],
    insertToolMessage: [] as { content: string }[],
    updateToolMessage: [] as { id: string; content: string }[],
  };
  let toolSeq = 0;
  return {
    calls,
    async updateMessageContent(id: string, content: string) {
      calls.updateMessageContent.push({ id, content });
    },
    async markFirstModelCall(runId: string) {
      calls.markFirstModelCall.push(runId);
    },
    async setRunStatus(runId: string, status: string, iterations?: number) {
      calls.setRunStatus.push({ runId, status, iterations });
    },
    async insertUsageEvent(row: unknown) {
      calls.insertUsageEvent.push(row);
    },
    async refundRun(runId: string) {
      calls.refundRun.push(runId);
    },
    async insertToolMessage(row: { content: string }) {
      calls.insertToolMessage.push({ content: row.content });
      return `tool-${++toolSeq}`;
    },
    async updateToolMessage(id: string, content: string) {
      calls.updateToolMessage.push({ id, content });
    },
  };
}

function fakeTools(over: Partial<AgentTools> = {}): AgentTools {
  return {
    web_search: over.web_search ?? (async () => ({ results: [], note: undefined })),
    fetch_page:
      over.fetch_page ?? (async () => ({ text: "page text", domain: "example.com", tokensApprox: 3 })),
  };
}

function collectSend() {
  const events: { event: string; data: unknown }[] = [];
  return {
    events,
    send: (event: string, data: unknown) => events.push({ event, data }),
    kinds: () => events.map((e) => e.event),
  };
}

function baseParams(
  send: (e: string, d: unknown) => void,
  db: ReturnType<typeof fakeDb>,
  model: ReturnType<typeof scriptedModel>,
  tools: AgentTools,
  now?: () => number,
): RunAgentLoopParams {
  return {
    runId: "r1",
    chatId: "c1",
    userId: "u1",
    modelId: "gpt-5.6-luna",
    assistantMsgId: "a1",
    history: [{ role: "user", content: "research question" }],
    send,
    db,
    model,
    tools,
    now,
  };
}

const web_search = (id: string, query: string): ToolCallRequest => ({
  id,
  name: "web_search",
  arguments: JSON.stringify({ query }),
});

describe("runAgentLoop — think→act→observe (AGENT-01..05, PAY-06, D-28)", () => {
  it("runs one tool turn then a final answer: 2 iterations, tool_status running→done, observation fed back", async () => {
    const s = collectSend();
    const db = fakeDb();
    const searchSpy = vi.fn(async () => ({
      results: [{ title: "T", url: "https://x.io", snippet: "snip" }],
      note: undefined,
    }));
    const tools = fakeTools({ web_search: searchSpy });
    const model = scriptedModel([
      { toolCalls: [web_search("tc1", "EU AI Act")], usage: USAGE },
      { deltas: ["Final ", "answer."], usage: USAGE },
    ]);

    await runAgentLoop(baseParams(s.send, db, model, tools));

    expect(model.calls).toHaveLength(2);
    expect(searchSpy).toHaveBeenCalledWith("EU AI Act");
    // tool_status running then done for the search.
    const toolStatuses = s.events.filter((e) => e.event === "tool_status");
    expect(toolStatuses.map((e) => (e.data as { state: string }).state)).toEqual([
      "running",
      "done",
    ]);
    // The observation was fed into the SECOND model call.
    const secondCall = model.calls[1];
    expect(JSON.stringify(secondCall)).toContain("https://x.io");
    // Final answer persisted + succeeded.
    expect(db.calls.updateMessageContent.at(-1)!.content).toBe("Final answer.");
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "succeeded" });
    expect(db.calls.refundRun).toHaveLength(0);
    expect(db.calls.insertUsageEvent).toHaveLength(2); // one per model call
  });

  it("hard-caps at 12 iterations and ends budget_exhausted with the exact copy", async () => {
    const s = collectSend();
    const db = fakeDb();
    const tools = fakeTools();
    // Every turn requests a tool → never a final answer.
    const model = scriptedModel([{ toolCalls: [web_search("tc", "loop")], usage: USAGE }]);

    await runAgentLoop(baseParams(s.send, db, model, tools));

    expect(model.calls).toHaveLength(12);
    const last = db.calls.updateMessageContent.at(-1)!;
    expect(last.content).toContain(BUDGET_COPY);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({
      status: "budget_exhausted",
      iterations: 12,
    });
    expect(db.calls.refundRun).toHaveLength(0);
  });

  it("stops at the 240s self-budget with the exact copy and makes no tool dispatches", async () => {
    const s = collectSend();
    const db = fakeDb();
    const searchSpy = vi.fn(async () => ({ results: [], note: undefined }));
    const tools = fakeTools({ web_search: searchSpy });
    const model = scriptedModel([{ toolCalls: [web_search("tc", "x")], usage: USAGE }]);

    // Clock: 0 at start, then jumps past 240s before the first iteration body.
    let t = 0;
    let firstRead = true;
    const now = () => {
      if (firstRead) {
        firstRead = false;
        return 0; // startTime
      }
      t = 240_001;
      return t;
    };

    await runAgentLoop(baseParams(s.send, db, model, tools, now));

    expect(model.calls).toHaveLength(0); // no model call, no tool dispatch
    expect(searchSpy).not.toHaveBeenCalled();
    expect(db.calls.updateMessageContent.at(-1)!.content).toContain(BUDGET_COPY);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "budget_exhausted" });
  });

  it("converts a throwing tool into an observation and keeps going (AGENT-05)", async () => {
    const s = collectSend();
    const db = fakeDb();
    const tools = fakeTools({
      fetch_page: async () => {
        throw new Error("that link is not allowed");
      },
    });
    const model = scriptedModel([
      { toolCalls: [{ id: "tc1", name: "fetch_page", arguments: JSON.stringify({ url: "http://10.0.0.1" }) }], usage: USAGE },
      { deltas: ["Recovered."], usage: USAGE },
    ]);

    await expect(runAgentLoop(baseParams(s.send, db, model, tools))).resolves.toBeUndefined();

    // The failure was fed back as an observation into the next model call.
    expect(JSON.stringify(model.calls[1])).toContain("failed");
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "succeeded" });
    expect(db.calls.refundRun).toHaveLength(0);
  });

  it("rejects a tool-call whose JSON args fail zod and feeds it back without executing", async () => {
    const s = collectSend();
    const db = fakeDb();
    const searchSpy = vi.fn(async () => ({ results: [], note: undefined }));
    const tools = fakeTools({ web_search: searchSpy });
    const model = scriptedModel([
      { toolCalls: [{ id: "tc1", name: "web_search", arguments: JSON.stringify({ notquery: 1 }) }], usage: USAGE },
      { deltas: ["done"], usage: USAGE },
    ]);

    await runAgentLoop(baseParams(s.send, db, model, tools));

    expect(searchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(model.calls[1])).toContain("invalid tool arguments");
  });

  it("refunds exactly once when the FIRST model call throws before completing (PAY-06)", async () => {
    const s = collectSend();
    const db = fakeDb();
    const model = scriptedModel([{ throwAt: "before" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(db.calls.refundRun).toEqual(["r1"]);
    expect(db.calls.markFirstModelCall).toHaveLength(0);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
    const errFrame = s.events.find((e) => e.event === "error");
    expect(JSON.stringify(errFrame)).not.toContain("PROVIDER_RAW_401_BODY");
  });

  it("does NOT refund when a first model call completed then a later call fails", async () => {
    const s = collectSend();
    const db = fakeDb();
    const model = scriptedModel([
      { toolCalls: [web_search("tc1", "q")], usage: USAGE }, // completes → first marked
      { throwAt: "before" }, // second iteration model throws
    ]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(db.calls.refundRun).toHaveLength(0);
    expect(db.calls.markFirstModelCall).toHaveLength(1);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
  });

  it("emits a rate_limited event with the priority-ordered fallback when a model call throws 429 (no raw body leaked)", async () => {
    const s = collectSend();
    const db = fakeDb();
    const RAW_BODY = "429 upstream saturated: openrouter provider raw body xyz";
    const model = {
      calls: [] as ChatMessage[][],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *run(messages: ChatMessage[]): AsyncGenerator<ModelChunk> {
        this.calls.push(messages.map((m) => ({ ...m })));
        const err = new Error(RAW_BODY) as Error & { status?: number };
        err.status = 429;
        throw err;
        // eslint-disable-next-line no-unreachable
        yield {} as ModelChunk;
      },
    };

    await runAgentLoop({
      ...baseParams(s.send, db, model as never, fakeTools()),
      modelId: OPENROUTER_FREE_FALLBACK[0],
    });

    const rl = s.events.find((e) => e.event === "rate_limited");
    expect(rl, "rate_limited event emitted").toBeDefined();
    const data = rl!.data as { saturatedModelId: string; fallback: string[] };
    expect(data.saturatedModelId).toBe(OPENROUTER_FREE_FALLBACK[0]);
    expect(data.fallback).toEqual(OPENROUTER_FREE_FALLBACK.slice(1));
    // Secret hygiene: the raw provider body never appears in the frame.
    expect(JSON.stringify(rl)).not.toContain(RAW_BODY);
    // Pre-first-call 429 → refund fired; first-model-call gate untouched.
    expect(db.calls.refundRun).toEqual(["r1"]);
    expect(db.calls.markFirstModelCall).toHaveLength(0);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
  });

  it("meters every completed model call, never NaN even without a usage chunk", async () => {
    const db = fakeDb();
    const model = scriptedModel([{ deltas: ["hi"] }]); // no usage chunk
    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    expect(db.calls.insertUsageEvent).toHaveLength(1);
    const row = db.calls.insertUsageEvent[0] as { cost_usd: number; input_tokens: number };
    expect(Number.isNaN(row.cost_usd)).toBe(false);
    expect(row.input_tokens).toBe(0);
  });
});

describe("clean-finish guard (AI-SPEC New Risk #1 / EV-11)", () => {
  it.each(["max_tokens", "length"])(
    "appends the locked INCOMPLETE_COPY note when the terminal stopReason is %s",
    async (reason) => {
      const db = fakeDb();
      const model = scriptedModel([
        { deltas: ["A truncated mid-sentence answ"], usage: USAGE, stopReason: reason },
      ]);
      await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

      const last = db.calls.updateMessageContent.at(-1)!;
      expect(last.content).toContain("A truncated mid-sentence answ");
      expect(last.content.endsWith(INCOMPLETE_COPY)).toBe(true);
    },
  );

  it.each(["end_turn", "stop", "tool_use", "stop_sequence", "tool_calls"])(
    "appends NO note for the clean stopReason %s",
    async (reason) => {
      const db = fakeDb();
      const model = scriptedModel([
        { deltas: ["Clean answer."], usage: USAGE, stopReason: reason },
      ]);
      await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

      expect(db.calls.updateMessageContent.at(-1)!.content).toBe("Clean answer.");
    },
  );

  it("treats an undefined stopReason as clean (lenient providers may omit it)", async () => {
    const db = fakeDb();
    const model = scriptedModel([{ deltas: ["Clean answer."], usage: USAGE }]);
    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    expect(db.calls.updateMessageContent.at(-1)!.content).toBe("Clean answer.");
  });

  it("routes model_context_window_exceeded to CONTEXT_TOO_LONG_COPY instead of the generic note", async () => {
    const db = fakeDb();
    const model = scriptedModel([
      {
        deltas: ["Partial answer"],
        usage: USAGE,
        stopReason: "model_context_window_exceeded",
      },
    ]);
    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    const last = db.calls.updateMessageContent.at(-1)!;
    expect(last.content.endsWith(CONTEXT_TOO_LONG_COPY)).toBe(true);
    expect(last.content).not.toContain(INCOMPLETE_COPY);
  });

  it("maps a 400 context-length provider ERROR to the context-too-long copy", async () => {
    const s = collectSend();
    const db = fakeDb();
    const RAW = "prompt is too long: maximum context length is N tokens (raw body)";
    const model = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *run(): AsyncGenerator<ModelChunk> {
        const err = new Error(RAW) as Error & { status?: number };
        err.status = 400;
        throw err;
        // eslint-disable-next-line no-unreachable
        yield {} as ModelChunk;
      },
    };
    await runAgentLoop(baseParams(s.send, db, model as never, fakeTools()));

    const last = db.calls.updateMessageContent.at(-1)!;
    expect(last.content).toContain(CONTEXT_TOO_LONG_COPY);
    expect(JSON.stringify(s.events)).not.toContain(RAW);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
  });
});

describe("mapProviderError secret hygiene (EV-18 delta row)", () => {
  it.each([[401], [403], [429], [500], [undefined]])(
    "status %s: neither the api key nor the raw provider body ever reaches an SSE frame or the DB",
    async (status) => {
      const s = collectSend();
      const db = fakeDb();
      const SECRET = "sk-ant-super-secret-key-fragment";
      const RAW_BODY = `provider raw body: unauthorized for key ${SECRET} (detail xyz)`;
      const model = {
        // eslint-disable-next-line @typescript-eslint/require-await
        async *run(): AsyncGenerator<ModelChunk> {
          const err = new Error(RAW_BODY) as Error & { status?: number };
          if (status !== undefined) err.status = status;
          throw err;
          // eslint-disable-next-line no-unreachable
          yield {} as ModelChunk;
        },
      };
      await runAgentLoop(baseParams(s.send, db, model as never, fakeTools()));

      const everything =
        JSON.stringify(s.events) + JSON.stringify(db.calls.updateMessageContent);
      expect(everything).not.toContain(SECRET);
      expect(everything).not.toContain(RAW_BODY);
      // A human-readable mapped message was still delivered.
      const errFrame = s.events.find((e) => e.event === "error");
      expect(errFrame).toBeDefined();
      expect((errFrame!.data as { message: string }).message.length).toBeGreaterThan(0);
    },
  );
});

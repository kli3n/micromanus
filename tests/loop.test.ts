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

/** DB methods a test may make reject (WR-04 injected-failure cases). */
type FailableDbMethod =
  | "updateMessageContent"
  | "markFirstModelCall"
  | "setRunStatus"
  | "setRunIterations"
  | "insertUsageEvent"
  | "refundRun"
  | "insertToolMessage"
  | "updateToolMessage";

/**
 * Fake DB. `rejectOn` (WR-04) maps a method name to the raw error message it
 * must throw — the call is still RECORDED first, so "called exactly once" holds
 * for a method that records then fails. Existing callers pass nothing and get
 * the always-succeeding shape unchanged.
 */
function fakeDb(rejectOn: Partial<Record<FailableDbMethod, string>> = {}) {
  const calls = {
    updateMessageContent: [] as { id: string; content: string }[],
    markFirstModelCall: [] as string[],
    setRunStatus: [] as { runId: string; status: string; iterations?: number }[],
    setRunIterations: [] as { runId: string; iterations: number }[],
    insertUsageEvent: [] as unknown[],
    refundRun: [] as string[],
    insertToolMessage: [] as { content: string }[],
    updateToolMessage: [] as { id: string; content: string }[],
  };
  let toolSeq = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  const maybeThrow = async (m: FailableDbMethod): Promise<void> => {
    const raw = rejectOn[m];
    if (raw !== undefined) {
      const err = new Error(raw);
      err.name = `Injected_${m}`;
      throw err;
    }
  };
  return {
    calls,
    async updateMessageContent(id: string, content: string) {
      calls.updateMessageContent.push({ id, content });
      await maybeThrow("updateMessageContent");
    },
    async markFirstModelCall(runId: string) {
      calls.markFirstModelCall.push(runId);
      await maybeThrow("markFirstModelCall");
    },
    async setRunStatus(runId: string, status: string, iterations?: number) {
      calls.setRunStatus.push({ runId, status, iterations });
      await maybeThrow("setRunStatus");
    },
    async setRunIterations(runId: string, iterations: number) {
      calls.setRunIterations.push({ runId, iterations });
      await maybeThrow("setRunIterations");
    },
    async insertUsageEvent(row: unknown) {
      calls.insertUsageEvent.push(row);
      await maybeThrow("insertUsageEvent");
    },
    async refundRun(runId: string) {
      calls.refundRun.push(runId);
      await maybeThrow("refundRun");
    },
    async insertToolMessage(row: { content: string }) {
      calls.insertToolMessage.push({ content: row.content });
      await maybeThrow("insertToolMessage");
      return `tool-${++toolSeq}`;
    },
    async updateToolMessage(id: string, content: string) {
      calls.updateToolMessage.push({ id, content });
      await maybeThrow("updateToolMessage");
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
    // tool_status running then done for the search (kind-discriminated plan /
    // meter payloads ride the same event — filter to the plain tool lines).
    const toolStatuses = s.events.filter(
      (e) => e.event === "tool_status" && (e.data as { kind?: string }).kind == null,
    );
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

// ============================ 03-04 additions ============================

type KindPayload = {
  id?: string;
  kind?: string;
  state?: string;
  items?: string[];
  startedAt?: string;
  iterations?: number;
  elapsedMs?: number;
  n?: number;
  title?: string;
  extract?: string;
  results?: { title: string; url: string; domain: string }[];
  tool?: string;
};

/** All persisted tool-row payloads (insert + update), JSON-parsed. */
function rowPayloads(db: ReturnType<typeof fakeDb>): KindPayload[] {
  return [
    ...db.calls.insertToolMessage.map((r) => JSON.parse(r.content) as KindPayload),
    ...db.calls.updateToolMessage.map((r) => JSON.parse(r.content) as KindPayload),
  ];
}

describe("per-pass iteration writes + meter carrier (STAT-06, Correction C2, D-56)", () => {
  it("calls setRunIterations once per pass with 1,2,3… — including the tool pass — BEFORE each model stream", async () => {
    const seq: string[] = [];
    const db = fakeDb();
    const origSetIter = db.setRunIterations.bind(db);
    db.setRunIterations = async (runId: string, n: number) => {
      seq.push(`iter:${n}`);
      await origSetIter(runId, n);
    };
    const inner = scriptedModel([
      { toolCalls: [web_search("tc1", "q")], usage: USAGE },
      { deltas: ["Done."], usage: USAGE },
    ]);
    const model = {
      calls: inner.calls,
      run(messages: ChatMessage[]) {
        seq.push("model");
        return inner.run(messages);
      },
    };

    await runAgentLoop(baseParams(() => {}, db, model as never, fakeTools()));

    expect(db.calls.setRunIterations).toEqual([
      { runId: "r1", iterations: 1 },
      { runId: "r1", iterations: 2 },
    ]);
    expect(seq).toEqual(["iter:1", "model", "iter:2", "model"]);
  });

  it("sends a meter SSE event with the pass number at the top of every pass", async () => {
    const s = collectSend();
    const db = fakeDb();
    const model = scriptedModel([
      { toolCalls: [web_search("tc1", "q")], usage: USAGE },
      { deltas: ["Done."], usage: USAGE },
    ]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    const meters = s.events.filter((e) => e.event === "meter");
    expect(meters.map((e) => (e.data as { iterations: number }).iterations)).toEqual([
      1, 2,
    ]);
  });

  it("emits a meter carrier row at loop start and settles it with iterations + server-computed elapsedMs on success", async () => {
    const s = collectSend();
    const db = fakeDb();
    const model = scriptedModel([{ deltas: ["Answer."], usage: USAGE }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    const inserted = db.calls.insertToolMessage
      .map((r) => JSON.parse(r.content) as KindPayload)
      .filter((p) => p.kind === "meter");
    expect(inserted).toHaveLength(1);
    expect(inserted[0].state).toBe("running");
    expect(typeof inserted[0].startedAt).toBe("string");
    expect(inserted[0].id).toBeTruthy();

    const settled = db.calls.updateToolMessage
      .map((r) => JSON.parse(r.content) as KindPayload)
      .filter((p) => p.kind === "meter");
    expect(settled).toHaveLength(1);
    expect(settled[0].state).toBe("done");
    expect(settled[0].iterations).toBe(1);
    expect(typeof settled[0].elapsedMs).toBe("number");
    expect(settled[0].startedAt).toBe(inserted[0].startedAt);

    // The live tab saw the same two payloads over tool_status SSE.
    const sse = s.events
      .filter((e) => e.event === "tool_status")
      .map((e) => e.data as KindPayload)
      .filter((p) => p.kind === "meter");
    expect(sse.map((p) => p.state)).toEqual(["running", "done"]);
  });

  it("settles the meter carrier on budget exhaust (12-iteration cap)", async () => {
    const db = fakeDb();
    const model = scriptedModel([{ toolCalls: [web_search("tc", "loop")], usage: USAGE }]);

    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    const settled = rowPayloads(db).filter(
      (p) => p.kind === "meter" && p.state === "done",
    );
    expect(settled).toHaveLength(1);
    expect(settled[0].iterations).toBe(12);
    expect(db.calls.setRunIterations).toHaveLength(12);
  });

  it("settles the meter carrier on a failed run (catch path)", async () => {
    const db = fakeDb();
    const model = scriptedModel([{ throwAt: "before" }]);

    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    const settled = rowPayloads(db).filter(
      (p) => p.kind === "meter" && p.state === "done",
    );
    expect(settled).toHaveLength(1);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
  });
});

describe("plan-block detection (RSCH-01, D-31/D-33/D-52)", () => {
  const PLAN_DELTAS = [
    "Let me plan.\n\n```plan\n1. First",
    " question\n2. Second question\n```",
    "\n\nStarting research now.",
  ];

  it("persists exactly ONE {kind:'plan'} row when the first turn streams a fence across deltas (re-scans never duplicate)", async () => {
    const s = collectSend();
    const db = fakeDb();
    const model = scriptedModel([
      { deltas: PLAN_DELTAS, toolCalls: [web_search("tc1", "q")], usage: USAGE },
      { deltas: ["Final."], usage: USAGE },
    ]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    const planRows = db.calls.insertToolMessage
      .map((r) => JSON.parse(r.content) as KindPayload)
      .filter((p) => p.kind === "plan");
    expect(planRows).toHaveLength(1);
    expect(planRows[0]).toMatchObject({
      kind: "plan",
      state: "done",
      items: ["First question", "Second question"],
    });
    expect(planRows[0].id).toBeTruthy();
    // The same payload went out as a tool_status SSE event.
    const sse = s.events
      .filter((e) => e.event === "tool_status")
      .map((e) => e.data as KindPayload)
      .filter((p) => p.kind === "plan");
    expect(sse).toHaveLength(1);
  });

  it("creates NO plan row when the fence arrives on a later turn (first-turn-only)", async () => {
    const db = fakeDb();
    const model = scriptedModel([
      { toolCalls: [web_search("tc1", "q")], usage: USAGE }, // iter 0: no fence
      {
        deltas: ["```plan\n1. Late plan\n```"],
        toolCalls: [web_search("tc2", "r")],
        usage: USAGE,
      },
      { deltas: ["Final."], usage: USAGE },
    ]);

    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    expect(rowPayloads(db).filter((p) => p.kind === "plan")).toHaveLength(0);
  });

  it("creates no row, no card, no error when no fence streams (graceful absence)", async () => {
    const db = fakeDb();
    const model = scriptedModel([{ deltas: ["Plain answer."], usage: USAGE }]);

    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    expect(rowPayloads(db).filter((p) => p.kind === "plan")).toHaveLength(0);
    expect(db.calls.updateMessageContent.at(-1)!.content).toBe("Plain answer.");
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "succeeded" });
  });

  it("strips the fence from the terminal write (terminal content == stripPlanBlock(acc))", async () => {
    const db = fakeDb();
    const model = scriptedModel([
      { deltas: ["```plan\n1. A\n2. B\n```\n\n", "The answer."], usage: USAGE },
    ]);

    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    expect(db.calls.updateMessageContent.at(-1)!.content).toBe("The answer.");
  });

  it("strips the fence from the assistant turn pushed into conversation for the next turn (same function, both paths)", async () => {
    const db = fakeDb();
    const model = scriptedModel([
      { deltas: PLAN_DELTAS, toolCalls: [web_search("tc1", "q")], usage: USAGE },
      { deltas: ["Final."], usage: USAGE },
    ]);

    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    const secondCall = model.calls[1];
    const assistant = secondCall.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content).not.toContain("```plan");
    expect(assistant!.content).toContain("Let me plan.");
    expect(assistant!.content).toContain("Starting research now.");
  });
});

describe("source numbering + web_search results (RSCH-02, D-35/D-36)", () => {
  const fetch_page = (id: string, url: string): ToolCallRequest => ({
    id,
    name: "fetch_page",
    arguments: JSON.stringify({ url }),
  });

  it("assigns [n] on fetch_page success, echoes it into the observation, and grows the registry", async () => {
    const { createSourceRegistry } = await import("@/lib/agent/sources");
    const s = collectSend();
    const db = fakeDb();
    const reg = createSourceRegistry();
    const model = scriptedModel([
      { toolCalls: [fetch_page("tc1", "https://ok.io/a")], usage: USAGE },
      { deltas: ["Done."], usage: USAGE },
    ]);

    await runAgentLoop({
      ...baseParams(s.send, db, model, fakeTools()),
      sources: reg,
    });

    // Observation fed to the next model call opens with the assigned marker.
    const obs = JSON.stringify(model.calls[1]);
    expect(obs).toContain("[1] fetch_page(https://ok.io/a)");
    expect(obs).toContain("Cite this source as [1].");
    expect(reg.size()).toBe(1);
    // Resolved tool_status payload carries n + title.
    const done = s.events
      .map((e) => e.data as KindPayload)
      .find((p) => p.tool === "fetch_page" && p.state === "done");
    expect(done).toBeDefined();
    expect(done!.n).toBe(1);
    expect(typeof done!.title).toBe("string");
    // The persisted done payload stores the EXACT <page> extraction the model
    // saw (offline-eval reference text for EV-02/EV-03 — closed-book, no
    // re-fetch). Same payload live and replayed (EV-17 twin invariant).
    expect(done!.extract).toBe("page text");
    const persisted = rowPayloads(db).find(
      (p) => p.tool === "fetch_page" && p.state === "done",
    );
    expect(persisted?.extract).toBe("page text");
  });

  it("a throwing fetch consumes NO number and keeps the existing failure observation", async () => {
    const db = fakeDb();
    const { createSourceRegistry } = await import("@/lib/agent/sources");
    const reg = createSourceRegistry();
    const tools = fakeTools({
      fetch_page: async (url: string) => {
        if (url.includes("bad")) throw new Error("could not fetch the page");
        return { text: "ok", domain: "ok.io", tokensApprox: 1 };
      },
    });
    const model = scriptedModel([
      {
        toolCalls: [
          fetch_page("tc1", "https://bad.io/x"),
          fetch_page("tc2", "https://ok.io/a"),
        ],
        usage: USAGE,
      },
      { deltas: ["Done."], usage: USAGE },
    ]);

    await runAgentLoop({ ...baseParams(() => {}, db, model, tools), sources: reg });

    const obs = JSON.stringify(model.calls[1]);
    expect(obs).toContain("fetch_page(https://bad.io/x) failed:");
    // The failed fetch minted nothing — the successful one got [1].
    expect(obs).toContain("[1] fetch_page(https://ok.io/a)");
    expect(reg.size()).toBe(1);
    expect(reg.entries().map((e) => e.n)).toEqual([1]);
  });

  it("the same URL fetched twice reuses its number", async () => {
    const db = fakeDb();
    const { createSourceRegistry } = await import("@/lib/agent/sources");
    const reg = createSourceRegistry();
    const model = scriptedModel([
      {
        toolCalls: [
          fetch_page("tc1", "https://Example.com/a/"),
          fetch_page("tc2", "https://example.com/a#frag"),
        ],
        usage: USAGE,
      },
      { deltas: ["Done."], usage: USAGE },
    ]);

    await runAgentLoop({
      ...baseParams(() => {}, db, model, fakeTools()),
      sources: reg,
    });

    const obs = JSON.stringify(model.calls[1]);
    expect(reg.size()).toBe(1);
    expect(obs).toContain("[1] fetch_page(https://Example.com/a/)");
    expect(obs).toContain("[1] fetch_page(https://example.com/a#frag)");
    expect(obs).not.toContain("[2] fetch_page");
  });

  it("web_search done payload carries results[] {title,url,domain} (<=8) for 'Also found' — never numbered", async () => {
    const s = collectSend();
    const db = fakeDb();
    const tools = fakeTools({
      web_search: async () => ({
        results: [
          { title: "One", url: "https://a.io/one", snippet: "s1" },
          { title: "Two", url: "https://b.example.org/two", snippet: "s2" },
        ],
        note: undefined,
      }),
    });
    const model = scriptedModel([
      { toolCalls: [web_search("tc1", "q")], usage: USAGE },
      { deltas: ["Done."], usage: USAGE },
    ]);

    await runAgentLoop(baseParams(s.send, db, model, tools));

    const done = s.events
      .map((e) => e.data as KindPayload)
      .find((p) => p.tool === "web_search" && p.state === "done");
    expect(done).toBeDefined();
    expect(done!.results).toEqual([
      { title: "One", url: "https://a.io/one", domain: "a.io" },
      { title: "Two", url: "https://b.example.org/two", domain: "b.example.org" },
    ]);
    expect(done!.n).toBeUndefined(); // search hits are never numbered (D-36)
    // The persisted done row carries the same results payload.
    const row = db.calls.updateToolMessage
      .map((r) => JSON.parse(r.content) as KindPayload)
      .find((p) => p.tool === "web_search" && p.state === "done");
    expect(row?.results).toHaveLength(2);
  });

  it("three fetch_page calls in one turn = ONE iteration, three sequential observations (parallel dispatch preserved)", async () => {
    const db = fakeDb();
    const model = scriptedModel([
      {
        toolCalls: [
          fetch_page("tc1", "https://a.io/1"),
          fetch_page("tc2", "https://b.io/2"),
          fetch_page("tc3", "https://c.io/3"),
        ],
        usage: USAGE,
      },
      { deltas: ["Synthesis."], usage: USAGE },
    ]);

    await runAgentLoop(baseParams(() => {}, db, model, fakeTools()));

    expect(model.calls).toHaveLength(2); // one tool pass + one final pass
    expect(db.calls.setRunIterations.map((c) => c.iterations)).toEqual([1, 2]);
    const obs = model.calls[1].find((m) =>
      m.content.startsWith("Tool observations:"),
    );
    expect(obs).toBeDefined();
    expect(obs!.content).toContain("[1] fetch_page(https://a.io/1)");
    expect(obs!.content).toContain("[2] fetch_page(https://b.io/2)");
    expect(obs!.content).toContain("[3] fetch_page(https://c.io/3)");
  });
});

// ============================ 03-05 additions ============================

describe("create_pdf_report tool (RSCH-03, D-44/D-45)", () => {
  const create_pdf_report = (id: string, args: unknown): ToolCallRequest => ({
    id,
    name: "create_pdf_report",
    arguments: JSON.stringify(args),
  });

  it("returns the queued observation SYNCHRONOUSLY, consumes exactly one iteration, records {title, markdown}", async () => {
    const s = collectSend();
    const db = fakeDb();
    const report: { queued?: { title: string; markdown: string } } = {};
    const longMd = "The full report body with inline [1] markers. ".repeat(10); // > 200 chars
    const model = scriptedModel([
      { toolCalls: [create_pdf_report("tc1", { title: "My Report", markdown: longMd })], usage: USAGE },
      { deltas: ["Final answer."], usage: USAGE },
    ]);

    // Frozen clock: zero elapsed anywhere — the branch must not await any
    // render (Chromium never runs inside the 240s budget, D-44/Pitfall 5).
    await runAgentLoop({
      ...baseParams(s.send, db, model, fakeTools(), () => 0),
      report,
    });

    expect(model.calls).toHaveLength(2);
    // D-45: the call consumed exactly one of the 12 iterations, no special-casing.
    expect(db.calls.setRunIterations.map((c) => c.iterations)).toEqual([1, 2]);
    const obs = JSON.stringify(model.calls[1]);
    expect(obs).toContain(
      "report queued — it will appear as a download below your answer",
    );
    expect(report.queued).toEqual({ title: "My Report", markdown: longMd });

    // UI-SPEC locked tool-status copy.
    const statuses = s.events
      .filter((e) => e.event === "tool_status")
      .map((e) => e.data as { tool?: string; state?: string; label?: string; meta?: string });
    const running = statuses.find(
      (p) => p.tool === "create_pdf_report" && p.state === "running",
    );
    const done = statuses.find(
      (p) => p.tool === "create_pdf_report" && p.state === "done",
    );
    expect(running).toMatchObject({
      label: "Preparing report",
      meta: "renders after the run",
    });
    expect(done).toMatchObject({ label: "Report queued" });
  });

  it("args failing zod produce an error observation, never a throw, and queue nothing", async () => {
    const db = fakeDb();
    const report: { queued?: { title: string; markdown: string } } = {};
    const model = scriptedModel([
      { toolCalls: [create_pdf_report("tc1", { title: "" })], usage: USAGE },
      { deltas: ["Recovered."], usage: USAGE },
    ]);

    await expect(
      runAgentLoop({ ...baseParams(() => {}, db, model, fakeTools()), report }),
    ).resolves.toBeUndefined();

    expect(JSON.stringify(model.calls[1])).toContain(
      "create_pdf_report → invalid tool arguments",
    );
    expect(report.queued).toBeUndefined();
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "succeeded" });
  });

  it("markdown shorter than 200 chars falls back to the stripPlanBlock'd terminal answer body (weak-model guard)", async () => {
    const db = fakeDb();
    const report: { queued?: { title: string; markdown: string } } = {};
    const model = scriptedModel([
      { toolCalls: [create_pdf_report("tc1", { title: "T", markdown: "stub" })], usage: USAGE },
      {
        deltas: ["```plan\n1. A\n```\n\n", "The full terminal answer body."],
        usage: USAGE,
      },
    ]);

    await runAgentLoop({ ...baseParams(() => {}, db, model, fakeTools()), report });

    expect(report.queued).toBeDefined();
    expect(report.queued!.title).toBe("T");
    expect(report.queued!.markdown).toBe("The full terminal answer body.");
  });

  it("markdown of 200+ chars is kept verbatim — no fallback", async () => {
    const db = fakeDb();
    const report: { queued?: { title: string; markdown: string } } = {};
    const longMd = "m".repeat(250);
    const model = scriptedModel([
      { toolCalls: [create_pdf_report("tc1", { title: "T", markdown: longMd })], usage: USAGE },
      { deltas: ["Terminal answer."], usage: USAGE },
    ]);

    await runAgentLoop({ ...baseParams(() => {}, db, model, fakeTools()), report });

    expect(report.queued!.markdown).toBe(longMd);
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

describe("WR-04: the terminal write always lands and the loop never rejects out of its catch", () => {
  // A transient DB failure is MOST likely exactly on a failure path, and every
  // client stops waiting only on a non-'running' runs.status: if an earlier
  // terminal step throws, the run wedges at 'running' forever — on this tab AND
  // on every future reopen (T-03-12-03). So each terminal step is guarded and the
  // status write is unconditional and LAST.
  const RAW_PG_BODY =
    'POSTGRES_RAW_BODY: duplicate key value violates unique constraint "credit_ledger_ref" detail=(user_id)=(u1)';
  const MAPPED_COPY = "The research run failed to complete. Please try again.";

  it("writes the terminal failed run status exactly once when refundRun rejects", async () => {
    const s = collectSend();
    const db = fakeDb({ refundRun: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]); // pre-first-call → refund path

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(db.calls.refundRun).toEqual(["r1"]); // the refund CONDITION is untouched
    expect(db.calls.setRunStatus).toHaveLength(1);
    expect(db.calls.setRunStatus[0]).toMatchObject({
      runId: "r1",
      status: "failed",
    });
    // The terminal content write is reached too — the placeholder gets real copy.
    expect(db.calls.updateMessageContent.at(-1)).toMatchObject({
      id: "a1",
      content: MAPPED_COPY,
    });
    errSpy.mockRestore();
  });

  it("writes the terminal failed run status exactly once when updateMessageContent rejects", async () => {
    const s = collectSend();
    const db = fakeDb({ updateMessageContent: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // First call completes (firstMarked) then the second throws → no refund.
    const model = scriptedModel([
      { toolCalls: [web_search("tc1", "q")], usage: USAGE },
      { throwAt: "before" },
    ]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(db.calls.refundRun).toHaveLength(0); // refund condition unchanged
    expect(db.calls.updateMessageContent).toHaveLength(1);
    expect(db.calls.setRunStatus).toHaveLength(1);
    expect(db.calls.setRunStatus[0]).toMatchObject({ status: "failed" });
    errSpy.mockRestore();
  });

  it("resolves rather than rejecting when setRunStatus itself rejects", async () => {
    const s = collectSend();
    const db = fakeDb({ setRunStatus: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]);

    await expect(
      runAgentLoop(baseParams(s.send, db, model, fakeTools())),
    ).resolves.toBeUndefined();

    // Was 1 before 03-14. The run-status step — and ONLY that step — now gets
    // one bounded re-attempt (GW-01), so a setRunStatus that rejects on every
    // call is seen exactly twice. The assertion this test exists for is the
    // `.resolves` above; the count is tightened, not relaxed: still an exact
    // number, still every call terminal, and still no third attempt.
    expect(db.calls.setRunStatus).toHaveLength(2);
    expect(db.calls.setRunStatus.every((c) => c.status === "failed")).toBe(true);
    errSpy.mockRestore();
  });

  it("resolves in every injected-failure case, so the promise handed to waitUntil always settles", async () => {
    for (const method of [
      "refundRun",
      "updateMessageContent",
      "setRunStatus",
    ] as const) {
      const s = collectSend();
      const db = fakeDb({ [method]: RAW_PG_BODY });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const model = scriptedModel([{ throwAt: "before" }]);

      await expect(
        runAgentLoop(baseParams(s.send, db, model, fakeTools())),
        `runAgentLoop must resolve when ${method} rejects`,
      ).resolves.toBeUndefined();

      errSpy.mockRestore();
    }
  });

  it("still emits the error and done(failed) SSE events when a guarded terminal step failed", async () => {
    const s = collectSend();
    const db = fakeDb({ refundRun: RAW_PG_BODY, updateMessageContent: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    const done = s.events.find((e) => e.event === "done");
    expect(done, "done event still emitted").toBeDefined();
    expect(done!.data).toMatchObject({ runId: "r1", status: "failed" });
    expect(s.events.some((e) => e.event === "error")).toBe(true);
    // ...and the status write still landed despite BOTH earlier steps failing.
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
    errSpy.mockRestore();
  });

  it("logs the guarded failure by NAME only — no Postgres body reaches a log call (T-03-12-04)", async () => {
    const s = collectSend();
    const db = fakeDb({ refundRun: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    const logged = errSpy.mock.calls.map((c) =>
      c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    );
    const all = logged.join("\n");
    expect(all).not.toContain("POSTGRES_RAW_BODY");
    expect(all).not.toContain("credit_ledger_ref");
    // The error NAME is what identifies it, and the label names the step.
    expect(all).toContain("Injected_refundRun");
    expect(all).toContain("refund");
    errSpy.mockRestore();
  });
});

describe("GW-01: the run-status terminal step is retried once, and a metering blip never fails a run", () => {
  // 03-14 Task 1 made the injected Db actually throw on a Postgres refusal, so
  // the WR-04 guard above is finally live in production. Two consequences are
  // pinned here: the run-status write — the ONLY signal every client waits on —
  // gets one immediate re-attempt, and nothing else does; and a throwing
  // usage_events insert is logged by name without failing an otherwise-good
  // paid run (visibility and survivability are different requirements).
  const RAW_PG_BODY =
    'POSTGRES_RAW_BODY: permission denied for table runs detail=(user_id)=(u1)';

  /** fakeDb's `rejectOn` throws unconditionally, so a "fails once then works"
   *  case needs this local wrapper. fakeDb itself is left untouched. */
  function dbFailingFirstSetRunStatus() {
    const db = fakeDb();
    let n = 0;
    return {
      ...db,
      async setRunStatus(runId: string, status: string, iterations?: number) {
        n += 1;
        await db.setRunStatus(runId, status, iterations);
        if (n === 1) {
          const err = new Error(RAW_PG_BODY);
          err.name = "Injected_setRunStatus_firstAttempt";
          throw err;
        }
      },
    };
  }

  it("re-attempts the run-status write once and stops as soon as it lands", async () => {
    const s = collectSend();
    const db = dbFailingFirstSetRunStatus();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(db.calls.setRunStatus).toHaveLength(2);
    expect(db.calls.setRunStatus.every((c) => c.status === "failed")).toBe(true);
    // Exactly ONE failure line — the successful second attempt logs nothing.
    const stepLines = errSpy.mock.calls
      .map((c) => c.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
      .filter((l) => l.includes('terminal step "run status" failed'));
    expect(stepLines).toHaveLength(1);
    expect(stepLines[0]).toContain("Injected_setRunStatus_firstAttempt");
    expect(stepLines[0]).not.toContain("POSTGRES_RAW_BODY");
    errSpy.mockRestore();
  });

  it("gives up after exactly two attempts and still resolves with error + done(failed)", async () => {
    const s = collectSend();
    const db = fakeDb({ setRunStatus: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]);

    await expect(
      runAgentLoop(baseParams(s.send, db, model, fakeTools())),
    ).resolves.toBeUndefined();

    expect(db.calls.setRunStatus).toHaveLength(2);
    expect(s.events.some((e) => e.event === "error")).toBe(true);
    expect(s.events.find((e) => e.event === "done")!.data).toMatchObject({
      status: "failed",
    });
    errSpy.mockRestore();
  });

  it("does NOT retry the refund step — a throwing refundRun is attempted exactly once", async () => {
    const s = collectSend();
    const db = fakeDb({ refundRun: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(db.calls.refundRun).toHaveLength(1);
    errSpy.mockRestore();
  });

  it("does NOT retry the terminal content write — a throwing updateMessageContent is attempted once", async () => {
    const s = collectSend();
    const db = fakeDb({ updateMessageContent: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(db.calls.updateMessageContent).toHaveLength(1);
    errSpy.mockRestore();
  });

  it("does NOT retry the meter settle step — a throwing tool-row update is attempted once", async () => {
    const s = collectSend();
    const db = fakeDb({ updateToolMessage: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(db.calls.updateToolMessage).toHaveLength(1);
    errSpy.mockRestore();
  });

  it("a throwing insertUsageEvent is logged by NAME and the run still succeeds", async () => {
    const s = collectSend();
    const db = fakeDb({ insertUsageEvent: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ deltas: ["the answer"], usage: USAGE, stopReason: "stop" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(s.events.find((e) => e.event === "done")!.data).toMatchObject({
      runId: "r1",
      status: "succeeded",
    });
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "succeeded" });
    // Logged, and by name only.
    const all = errSpy.mock.calls
      .map((c) => c.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
      .join("\n");
    expect(all).toContain("insertUsageEvent failed");
    expect(all).toContain("Injected_insertUsageEvent");
    expect(all).not.toContain("POSTGRES_RAW_BODY");
    errSpy.mockRestore();
  });
});

describe("GW-06: a terminal body already persisted is never clobbered by the failure copy", () => {
  // The catch block's terminal content write used to be unconditional. Once
  // 03-14 Task 1 made the injected Db throw, a transient failure on the very
  // LAST write of a successful run would overwrite the complete answer the user
  // just watched stream with "The research run failed to complete." — the whole
  // artifact of a paid run destroyed by a blip. `terminalBodyWritten` records
  // that a body is DURABLY persisted (it is set after the await, not before)
  // and the catch respects it. The run-status write stays unconditional and
  // last: reporting `failed` is the honest record of what happened to the run
  // row, even though the answer survives.
  const RAW_PG_BODY = "POSTGRES_RAW_BODY: permission denied for table runs";
  const MAPPED_COPY = "The research run failed to complete. Please try again.";
  const ANSWER = "The full researched answer the user watched stream.";

  it("success path: a failing setRunStatus does NOT overwrite the delivered answer", async () => {
    const s = collectSend();
    const db = fakeDb({ setRunStatus: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ deltas: [ANSWER], usage: USAGE, stopReason: "stop" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    // Exactly ONE content write, carrying the answer. A clobber would append a
    // second call carrying MAPPED_COPY — this is the strongest available
    // statement of "the answer survived".
    expect(db.calls.updateMessageContent).toHaveLength(1);
    expect(db.calls.updateMessageContent[0]).toMatchObject({
      id: "a1",
      content: ANSWER,
    });
    expect(JSON.stringify(db.calls.updateMessageContent)).not.toContain(MAPPED_COPY);
    // ...and the run row is still honestly marked failed, unconditionally last.
    expect(db.calls.setRunStatus[0]).toMatchObject({ status: "succeeded" });
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
    errSpy.mockRestore();
  });

  it("budget path: a failing setRunStatus does NOT overwrite the locked budget copy", async () => {
    const s = collectSend();
    const db = fakeDb({ setRunStatus: RAW_PG_BODY });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ toolCalls: [web_search("tc", "x")], usage: USAGE }]);

    // Same clock shape as the 240s budget test above.
    let firstRead = true;
    const now = () => {
      if (firstRead) {
        firstRead = false;
        return 0;
      }
      return 240_001;
    };

    await runAgentLoop(baseParams(s.send, db, model, fakeTools(), now));

    expect(db.calls.updateMessageContent).toHaveLength(1);
    expect(db.calls.updateMessageContent.at(-1)!.content).toContain(BUDGET_COPY);
    expect(db.calls.updateMessageContent.at(-1)!.content).not.toContain(MAPPED_COPY);
    expect(db.calls.setRunStatus[0]).toMatchObject({ status: "budget_exhausted" });
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
    errSpy.mockRestore();
  });

  it("no terminal body written yet: the mapped failure copy IS persisted (the guard is not over-applied)", async () => {
    const s = collectSend();
    const db = fakeDb();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([{ throwAt: "before" }]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    expect(db.calls.updateMessageContent).toHaveLength(1);
    expect(db.calls.updateMessageContent[0]).toMatchObject({
      id: "a1",
      content: MAPPED_COPY,
    });
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
    errSpy.mockRestore();
  });

  it("a mid-run failure AFTER a completed tool turn still persists the failure copy — the flag tracks TERMINAL bodies only", async () => {
    const s = collectSend();
    const db = fakeDb();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel([
      { deltas: ["thinking"], toolCalls: [web_search("tc1", "q")], usage: USAGE },
      { throwAt: "before" },
    ]);

    await runAgentLoop(baseParams(s.send, db, model, fakeTools()));

    // The first turn wrote no terminal body (it dispatched a tool), so the
    // catch must still land the mapped copy.
    expect(db.calls.updateMessageContent.at(-1)).toMatchObject({
      content: MAPPED_COPY,
    });
    errSpy.mockRestore();
  });
});

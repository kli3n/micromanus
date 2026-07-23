import { describe, expect, it } from "vitest";
// RED (Task 1): these imports are unresolved until Task 2 creates the route
// module exporting the `createSseSender` + `runTurn` seams. Intended to fail now.
import { createSseSender, runTurn } from "@/app/api/agent/run/route";

const dec = new TextDecoder();

/**
 * Fake ReadableStream controller. `throwFrom` makes `enqueue` throw from the Nth
 * call onward (1 = throw on the very first send) to exercise the client-gone /
 * guarded-write path (Pitfall 3). Records decoded frames otherwise.
 */
function fakeController(opts: { throwFrom?: number } = {}) {
  const frames: string[] = [];
  let calls = 0;
  return {
    frames,
    enqueue(chunk: Uint8Array) {
      calls += 1;
      if (opts.throwFrom && calls >= opts.throwFrom) {
        throw new Error("controller closed (client gone)");
      }
      frames.push(dec.decode(chunk));
    },
  };
}

interface DbCalls {
  updateMessageContent: { id: string; content: string }[];
  markFirstModelCall: { runId: string }[];
  setRunStatus: { runId: string; status: string; iterations?: number }[];
  insertUsageEvent: unknown[];
  refundRun: { runId: string }[];
}

/** Fake Db recorder implementing the surface runTurn drives. */
function fakeDb() {
  const calls: DbCalls = {
    updateMessageContent: [],
    markFirstModelCall: [],
    setRunStatus: [],
    insertUsageEvent: [],
    refundRun: [],
  };
  return {
    calls,
    async updateMessageContent(id: string, content: string) {
      calls.updateMessageContent.push({ id, content });
    },
    async markFirstModelCall(runId: string) {
      calls.markFirstModelCall.push({ runId });
    },
    async setRunStatus(runId: string, status: string, iterations?: number) {
      calls.setRunStatus.push({ runId, status, iterations });
    },
    async insertUsageEvent(row: unknown) {
      calls.insertUsageEvent.push(row);
    },
    async refundRun(runId: string) {
      calls.refundRun.push({ runId });
    },
  };
}

/** Fake stream Model: yields delta chunks then a usage chunk; can throw. */
function fakeModel(opts: {
  deltas: string[];
  usage?: unknown;
  throwAt?: "before" | "after";
}) {
  return {
    // eslint-disable-next-line require-yield
    async *run() {
      if (opts.throwAt === "before") {
        throw new Error("PROVIDER_RAW_401_UNAUTHORIZED_BODY");
      }
      let i = 0;
      for (const d of opts.deltas) {
        yield { delta: d };
        i += 1;
        if (opts.throwAt === "after" && i === 1) {
          throw new Error("PROVIDER_RAW_500_SERVER_ERROR_BODY");
        }
      }
      if (opts.usage) yield { usage: opts.usage };
    },
  };
}

const ZERO_USAGE = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function baseOpts(send: (e: string, d: unknown) => void, db: ReturnType<typeof fakeDb>, model: ReturnType<typeof fakeModel>) {
  return {
    send,
    db,
    model,
    chatId: "c1",
    runId: "r1",
    userId: "u1",
    modelId: "gpt-5.6-luna",
    assistantMsgId: "a1",
    history: [],
  };
}

describe("createSseSender (CHAT-05 SSE frame + Pitfall 3 guarded write)", () => {
  it("send() enqueues exactly one well-formed SSE frame", () => {
    const c = fakeController();
    const sender = createSseSender(c as never);
    sender.send("token", { delta: "a" });
    expect(c.frames).toHaveLength(1);
    expect(c.frames[0]).toBe('event: token\ndata: {"delta":"a"}\n\n');
  });

  it("swallows an enqueue throw, flips alive=false, and no-ops subsequent sends", () => {
    const c = fakeController({ throwFrom: 1 });
    const sender = createSseSender(c as never);
    expect(sender.alive).toBe(true);
    expect(() => sender.send("token", { delta: "a" })).not.toThrow();
    expect(sender.alive).toBe(false);
    sender.send("token", { delta: "b" }); // no-op once dead
    expect(c.frames).toHaveLength(0);
  });
});

describe("runTurn (single-turn orchestration; CHAT-04/05/08, PAY-05/06)", () => {
  it("streams tokens, persists concatenated content, writes one usage row, marks first call, succeeds", async () => {
    const c = fakeController();
    const sender = createSseSender(c as never);
    const db = fakeDb();
    const model = fakeModel({ deltas: ["Hel", "lo"], usage: ZERO_USAGE });

    await runTurn(baseOpts(sender.send, db, model));

    const events = c.frames.map((f) => /^event: (\w+)/.exec(f)![1]);
    expect(events).toEqual(["token", "token", "usage", "done"]);
    expect(db.calls.markFirstModelCall).toHaveLength(1);
    expect(db.calls.insertUsageEvent).toHaveLength(1);
    expect(db.calls.updateMessageContent.at(-1)!.content).toBe("Hello");
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "succeeded" });
    expect(db.calls.refundRun).toHaveLength(0);
  });

  it("survives a dead stream: still persists content + usage row when the client is gone (CHAT-08)", async () => {
    const c = fakeController({ throwFrom: 1 }); // every enqueue throws
    const sender = createSseSender(c as never);
    const db = fakeDb();
    const model = fakeModel({ deltas: ["A", "B"], usage: ZERO_USAGE });

    await runTurn(baseOpts(sender.send, db, model));

    expect(sender.alive).toBe(false);
    expect(db.calls.updateMessageContent.at(-1)!.content).toBe("AB");
    expect(db.calls.insertUsageEvent).toHaveLength(1);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "succeeded" });
  });

  it("refunds and fails cleanly when the model throws BEFORE any delta (never leaks the raw body)", async () => {
    const c = fakeController();
    const sender = createSseSender(c as never);
    const db = fakeDb();
    const model = fakeModel({ deltas: [], throwAt: "before" });

    await runTurn(baseOpts(sender.send, db, model));

    expect(db.calls.refundRun).toHaveLength(1);
    expect(db.calls.markFirstModelCall).toHaveLength(0);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
    const errFrame = c.frames.find((f) => f.startsWith("event: error"));
    expect(errFrame).toBeDefined();
    expect(errFrame).not.toContain("PROVIDER_RAW_401_UNAUTHORIZED_BODY");
  });

  it("does NOT refund when the model throws AFTER the first delta; persists the partial content", async () => {
    const c = fakeController();
    const sender = createSseSender(c as never);
    const db = fakeDb();
    const model = fakeModel({ deltas: ["partial"], throwAt: "after" });

    await runTurn(baseOpts(sender.send, db, model));

    expect(db.calls.refundRun).toHaveLength(0);
    expect(db.calls.markFirstModelCall).toHaveLength(1);
    expect(db.calls.setRunStatus.at(-1)).toMatchObject({ status: "failed" });
    expect(db.calls.updateMessageContent.at(-1)!.content).toBe("partial");
  });
});

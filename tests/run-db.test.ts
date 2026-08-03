import { describe, expect, it, vi } from "vitest";
import { createRunDb, type RunDbClient } from "@/lib/agent/run-db";

/**
 * GW-01 (03-14). The service-role `Db` the run route injects used to discard
 * `error` on every write. supabase-js v2 RESOLVES `{ data, error }` for a
 * Postgres refusal and converts fetch-level failures into an error object
 * rather than rejecting — so `terminalStep`'s catch in lib/agent/loop.ts was
 * dead code in production: a refused `runs` UPDATE wedged the run at
 * `status='running'` with nothing logged, and a refused `refund_run` silently
 * kept the user's credit.
 *
 * These tests pin the `{ error }` → name-only throw conversion, per method,
 * plus the success-path shape of every method so the extraction out of
 * app/api/agent/run/route.ts cannot silently drift.
 *
 * Secret hygiene (T-03-14-01): a PostgrestError's `message`, `details` and
 * `hint` are attacker-influenced (a constraint name can echo a user-supplied
 * value) and Vercel function logs are durable. Only `error.code` may be read,
 * and it travels in `.name` because loop.ts's terminalStep logs `stepErr.name`
 * and discards the message.
 */

interface Recorded {
  table?: string;
  op: "update" | "insert" | "select-single" | "rpc";
  payload?: unknown;
  eqColumn?: string;
  eqValue?: unknown;
  rpcName?: string;
  selectColumns?: string;
}

/** A hand-built client matching the four chains `RunDbClient` declares. No
 *  @supabase/supabase-js import — the structural type is what makes that
 *  possible, and keeping it structural is the point of the seam. */
function fakeClient(result: { error?: unknown; data?: unknown } = {}) {
  const calls: Recorded[] = [];
  const res = { data: result.data ?? null, error: result.error ?? null };
  const client = {
    from(table: string) {
      return {
        update(patch: Record<string, unknown>) {
          return {
            eq(column: string, value: unknown) {
              calls.push({
                table,
                op: "update",
                payload: patch,
                eqColumn: column,
                eqValue: value,
              });
              return Promise.resolve(res);
            },
          };
        },
        insert(row: Record<string, unknown>) {
          calls.push({ table, op: "insert", payload: row });
          return Object.assign(Promise.resolve(res), {
            select(columns: string) {
              return {
                single() {
                  calls.push({ table, op: "select-single", selectColumns: columns });
                  return Promise.resolve(res);
                },
              };
            },
          });
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ op: "rpc", rpcName: name, payload: args });
      return Promise.resolve(res);
    },
  };
  return { client: client as unknown as RunDbClient, calls };
}

async function thrownBy(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it resolved");
}

const USAGE_ROW = {
  run_id: "r1",
  chat_id: "c1",
  user_id: "u1",
  model_id: "gpt-5.6-luna",
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  input_price_per_1m: 1,
  output_price_per_1m: 6,
  cache_read_price_per_1m: 0.1,
  cache_write_price_per_1m: 0,
  cost_usd: 0.00004,
};

describe("createRunDb — GW-01: a refused write is reported by NAME", () => {
  it("updateMessageContent throws RunDbError_updateMessageContent_{code}", async () => {
    const { client } = fakeClient({ error: { code: "23503" } });
    const db = createRunDb({ svc: client, userId: "u1" });
    const err = await thrownBy(db.updateMessageContent("a1", "body"));
    expect(err.name).toBe("RunDbError_updateMessageContent_23503");
  });

  it("setRunStatus throws RunDbError_setRunStatus_{code}", async () => {
    const { client } = fakeClient({ error: { code: "42501" } });
    const db = createRunDb({ svc: client, userId: "u1" });
    const err = await thrownBy(db.setRunStatus("r1", "failed", 3));
    expect(err.name).toBe("RunDbError_setRunStatus_42501");
  });

  it("setRunIterations throws RunDbError_setRunIterations_{code}", async () => {
    const { client } = fakeClient({ error: { code: "40001" } });
    const db = createRunDb({ svc: client, userId: "u1" });
    const err = await thrownBy(db.setRunIterations!("r1", 2));
    expect(err.name).toBe("RunDbError_setRunIterations_40001");
  });

  it("insertUsageEvent throws RunDbError_insertUsageEvent_{code}", async () => {
    const { client } = fakeClient({ error: { code: "23505" } });
    const db = createRunDb({ svc: client, userId: "u1" });
    const err = await thrownBy(db.insertUsageEvent(USAGE_ROW));
    expect(err.name).toBe("RunDbError_insertUsageEvent_23505");
  });

  it("refundRun throws RunDbError_refundRun_{code} — a silently-kept credit is impossible", async () => {
    const { client } = fakeClient({ error: { code: "P0001" } });
    const db = createRunDb({ svc: client, userId: "u1" });
    const err = await thrownBy(db.refundRun("r1"));
    expect(err.name).toBe("RunDbError_refundRun_P0001");
  });

  it("uses the literal 'unknown' when the error carries no code", async () => {
    const { client } = fakeClient({ error: {} });
    const db = createRunDb({ svc: client, userId: "u1" });
    const err = await thrownBy(db.setRunStatus("r1", "failed"));
    expect(err.name).toBe("RunDbError_setRunStatus_unknown");
  });

  it("every thrown error carries the fixed, non-sensitive message", async () => {
    const { client } = fakeClient({ error: { code: "23503" } });
    const db = createRunDb({ svc: client, userId: "u1" });
    for (const call of [
      () => db.updateMessageContent("a1", "b"),
      () => db.setRunStatus("r1", "failed"),
      () => db.setRunIterations!("r1", 1),
      () => db.insertUsageEvent(USAGE_ROW),
      () => db.refundRun("r1"),
    ]) {
      const err = await thrownBy(call());
      expect(err.message).toBe("run-db write failed");
    }
  });

  it("PG_SENTINEL_MESSAGE: no Postgres message, details or hint reaches the thrown error", async () => {
    const pgError = {
      code: "23505",
      message: "PG_SENTINEL_MESSAGE duplicate key value violates unique constraint",
      details: "PG_SENTINEL_DETAILS (user_id)=(u1)",
      hint: "PG_SENTINEL_HINT try again",
    };
    const { client } = fakeClient({ error: pgError });
    const db = createRunDb({ svc: client, userId: "u1" });

    for (const call of [
      () => db.updateMessageContent("a1", "b"),
      () => db.setRunStatus("r1", "failed"),
      () => db.setRunIterations!("r1", 1),
      () => db.insertUsageEvent(USAGE_ROW),
      () => db.refundRun("r1"),
    ]) {
      const err = await thrownBy(call());
      const surface = `${err.name}\n${err.message}\n${String(err)}`;
      expect(surface).not.toContain("PG_SENTINEL_MESSAGE");
      expect(surface).not.toContain("PG_SENTINEL_DETAILS");
      expect(surface).not.toContain("PG_SENTINEL_HINT");
      // The code is still there — it is the whole diagnostic payload.
      expect(err.name).toContain("23505");
    }
  });

  it("markFirstModelCall does NOT throw on { error } — firstMarked is already set, so a throw would fail the run without refunding", async () => {
    const { client } = fakeClient({ error: { code: "42501" } });
    const db = createRunDb({ svc: client, userId: "u1" });
    await expect(db.markFirstModelCall("r1")).resolves.toBeUndefined();
  });

  it("never mints a RunDbError_markFirstModelCall_ name", async () => {
    const { client } = fakeClient({ error: { code: "42501" } });
    const db = createRunDb({ svc: client, userId: "u1" });
    let seen = "";
    try {
      await db.markFirstModelCall("r1");
    } catch (err) {
      seen = (err as Error).name;
    }
    expect(seen).not.toContain("RunDbError_markFirstModelCall_");
    expect(seen).toBe("");
  });
});

describe("createRunDb — success-path shapes (anti-drift vs the route's original inline object)", () => {
  it("updateMessageContent updates messages.content by id", async () => {
    const { client, calls } = fakeClient();
    await createRunDb({ svc: client, userId: "u1" }).updateMessageContent("a1", "answer");
    expect(calls).toEqual([
      {
        table: "messages",
        op: "update",
        payload: { content: "answer" },
        eqColumn: "id",
        eqValue: "a1",
      },
    ]);
  });

  it("markFirstModelCall sets runs.first_model_call_completed by id", async () => {
    const { client, calls } = fakeClient();
    await createRunDb({ svc: client, userId: "u1" }).markFirstModelCall("r1");
    expect(calls).toEqual([
      {
        table: "runs",
        op: "update",
        payload: { first_model_call_completed: true },
        eqColumn: "id",
        eqValue: "r1",
      },
    ]);
  });

  it("setRunStatus writes status + ended_at, and iterations only when supplied", async () => {
    const withIter = fakeClient();
    await createRunDb({ svc: withIter.client, userId: "u1" }).setRunStatus("r1", "succeeded", 4);
    expect(withIter.calls[0]).toMatchObject({
      table: "runs",
      op: "update",
      eqColumn: "id",
      eqValue: "r1",
    });
    const patch = withIter.calls[0].payload as Record<string, unknown>;
    expect(patch.status).toBe("succeeded");
    expect(typeof patch.ended_at).toBe("string");
    expect(patch.iterations).toBe(4);

    const noIter = fakeClient();
    await createRunDb({ svc: noIter.client, userId: "u1" }).setRunStatus("r1", "failed");
    expect(Object.keys(noIter.calls[0].payload as object).sort()).toEqual([
      "ended_at",
      "status",
    ]);
  });

  it("setRunIterations writes ONLY iterations — never status or ended_at", async () => {
    const { client, calls } = fakeClient();
    await createRunDb({ svc: client, userId: "u1" }).setRunIterations!("r1", 7);
    expect(calls).toEqual([
      {
        table: "runs",
        op: "update",
        payload: { iterations: 7 },
        eqColumn: "id",
        eqValue: "r1",
      },
    ]);
  });

  it("insertUsageEvent inserts the row verbatim into usage_events", async () => {
    const { client, calls } = fakeClient();
    await createRunDb({ svc: client, userId: "u1" }).insertUsageEvent(USAGE_ROW);
    expect(calls).toEqual([{ table: "usage_events", op: "insert", payload: USAGE_ROW }]);
  });

  it("refundRun invokes the two-arg RPC with the CLOSURE userId (PAY-06)", async () => {
    const { client, calls } = fakeClient();
    await createRunDb({ svc: client, userId: "verified-user" }).refundRun("r1");
    expect(calls).toEqual([
      {
        op: "rpc",
        rpcName: "refund_run",
        payload: { p_user_id: "verified-user", p_run_id: "r1" },
      },
    ]);
  });
});

describe("createRunDb — the two tool-row writes keep their graceful-absence contract (D-52)", () => {
  it("insertToolMessage returns the new row id on success", async () => {
    const { client, calls } = fakeClient({ data: { id: "tool-1" } });
    const id = await createRunDb({ svc: client, userId: "u1" }).insertToolMessage!({
      chatId: "c1",
      userId: "u1",
      runId: "r1",
      content: "{}",
    });
    expect(id).toBe("tool-1");
    expect(calls[0]).toMatchObject({ table: "messages", op: "insert" });
    expect(calls[0].payload).toMatchObject({ chat_id: "c1", run_id: "r1", role: "tool" });
  });

  it("insertToolMessage logs and returns the empty string on error — it never throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({ error: { code: "23503" } });
    const id = await createRunDb({ svc: client, userId: "u1" }).insertToolMessage!({
      chatId: "c1",
      userId: "u1",
      runId: "r1",
      content: "{}",
    });
    expect(id).toBe("");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("updateToolMessage no-ops on an empty id and never throws on error", async () => {
    const empty = fakeClient({ error: { code: "23503" } });
    await expect(
      createRunDb({ svc: empty.client, userId: "u1" }).updateToolMessage!("", "x"),
    ).resolves.toBeUndefined();
    expect(empty.calls).toEqual([]);

    const real = fakeClient({ error: { code: "23503" } });
    await expect(
      createRunDb({ svc: real.client, userId: "u1" }).updateToolMessage!("t1", "x"),
    ).resolves.toBeUndefined();
    expect(real.calls).toEqual([
      {
        table: "messages",
        op: "update",
        payload: { content: "x" },
        eqColumn: "id",
        eqValue: "t1",
      },
    ]);
  });
});

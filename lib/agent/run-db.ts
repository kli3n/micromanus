import type { Db, ToolMessageRow, UsageEventRow } from "@/lib/agent/loop";

/**
 * The service-role `Db` the run lifecycle writes through (GW-01, 03-14).
 *
 * WHY THIS MODULE EXISTS — error VISIBILITY on the money and lifecycle writes.
 * supabase-js v2 does not reject on a Postgres refusal: a PostgrestBuilder
 * RESOLVES `{ data, error }`, and it converts fetch-level failures into an
 * error object too. The previous inline wrapper in app/api/agent/run/route.ts
 * discarded `error` in every method, which made `terminalStep`'s catch in
 * lib/agent/loop.ts dead code in production. Two consequences, both silent:
 * a refused `runs` UPDATE left the run at `status='running'` forever (every
 * client stops waiting only on a non-`running` status), and a refused
 * `refund_run` kept the user's credit on a run that never billed.
 *
 * SECRET HYGIENE (T-03-14-01). A PostgrestError's `message`, `details` and
 * `hint` are attacker-influenced — a constraint violation echoes the offending
 * value, which can be user-supplied — and Vercel function logs are durable.
 * So this module reads `error.code` and NOTHING else off the error object; the
 * fields deliberately never read are named here only to say so. The code
 * travels in the thrown error's `.name`, because loop.ts's `terminalStep` logs
 * `stepErr.name` and discards the message: a code put in the message would
 * never be printed, and a code taken from `error.message` would drag the whole
 * Postgres body into the log with it.
 */

/**
 * The minimal STRUCTURAL surface this wrapper needs from a Supabase client —
 * exactly the four chains below, deliberately NOT `SupabaseClient` and
 * deliberately not `any`. A structural type is what lets tests/run-db.test.ts
 * inject a hand-built fake with no SDK import while still type-checking the
 * chains, and it keeps the service-role client out of this module's imports.
 */
export interface RunDbClient {
  from(table: string): {
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<{ error: WriteError | null }>;
    };
    insert(row: Record<string, unknown>): PromiseLike<{ error: WriteError | null }> & {
      select(columns: string): {
        single(): PromiseLike<{
          data: { id: string } | null;
          error: WriteError | null;
        }>;
      };
    };
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: WriteError | null }>;
}

/** The ONLY field of a Postgres error this module is permitted to read. */
interface WriteError {
  code?: string | null;
}

/**
 * Convert a resolved `{ error }` into a throw whose NAME — and only whose name
 * — carries the Postgres code. One helper, one name template, so a future
 * method cannot invent a second shape that loop.ts's log line does not expect.
 */
function throwWriteError(method: string, error: WriteError): never {
  const err = new Error("run-db write failed");
  err.name = `RunDbError_${method}_${error.code ?? "unknown"}`;
  throw err;
}

/**
 * Build the run's `Db`. `userId` is the VERIFIED identity resolved by the
 * route; `refundRun` binds it into the two-arg service-role RPC (PAY-06) so
 * the loop never has to pass — or be able to choose — a user id.
 */
export function createRunDb(deps: { svc: RunDbClient; userId: string }): Db {
  const { svc, userId } = deps;

  return {
    async updateMessageContent(id: string, content: string): Promise<void> {
      const { error } = await svc.from("messages").update({ content }).eq("id", id);
      if (error) throwWriteError("updateMessageContent", error);
    },

    async markFirstModelCall(rid: string): Promise<void> {
      // DELIBERATELY non-throwing, unlike its five siblings. `firstMarked` in
      // lib/agent/loop.ts is set BEFORE this await, so the refund gate is
      // already closed by the time a throw could happen: throwing here would
      // convert a loggable inconsistency into a FAILED run that still does not
      // refund — strictly worse than the discard.
      await svc.from("runs").update({ first_model_call_completed: true }).eq("id", rid);
    },

    async setRunStatus(rid: string, status: string, iterations?: number): Promise<void> {
      const patch: Record<string, unknown> = {
        status,
        ended_at: new Date().toISOString(),
      };
      if (iterations != null) patch.iterations = iterations;
      const { error } = await svc.from("runs").update(patch).eq("id", rid);
      if (error) throwWriteError("setRunStatus", error);
    },

    async setRunIterations(rid: string, iterations: number): Promise<void> {
      // Per-pass write (Correction C2 / STAT-06): runs has replica identity
      // full (migration 0003), so this UPDATE is the Realtime event a reopened
      // tab's meter consumes. Non-terminal — never touches status/ended_at.
      const { error } = await svc.from("runs").update({ iterations }).eq("id", rid);
      if (error) throwWriteError("setRunIterations", error);
    },

    async insertUsageEvent(row: UsageEventRow): Promise<void> {
      const { error } = await svc.from("usage_events").insert({ ...row });
      if (error) throwWriteError("insertUsageEvent", error);
    },

    async refundRun(rid: string): Promise<void> {
      // Two-arg service-role RPC — BOTH the verified userId (closure) and runId
      // (PAY-06). Idempotent via credits_ledger_refund_once.
      const { error } = await svc.rpc("refund_run", { p_user_id: userId, p_run_id: rid });
      if (error) throwWriteError("refundRun", error);
    },

    async insertToolMessage(row: ToolMessageRow): Promise<string> {
      // A persisted role='tool' status row (D-25 reopen parity). Replayed via
      // Realtime so a reopened tab renders the same tool-status line.
      // Contract UNCHANGED by GW-01: logs and returns "", never throws — the
      // loop's emitToolStatus/resolveToolStatus treat a missing tool row as
      // graceful absence (D-52), so a throw here would fail a good run over a
      // cosmetic row.
      const { data, error } = await svc
        .from("messages")
        .insert({
          chat_id: row.chatId,
          user_id: row.userId,
          run_id: row.runId,
          role: "tool",
          content: row.content,
        })
        .select("id")
        .single();
      if (error || !data) {
        console.error(
          `[agent/run] run=${row.runId} insertToolMessage failed:`,
          error?.code ?? "unknown",
        );
        return "";
      }
      return data.id;
    },

    async updateToolMessage(id: string, content: string): Promise<void> {
      // Same graceful-absence contract: an empty id means insertToolMessage
      // already failed, and a failed update is a cosmetic loss.
      if (!id) return;
      await svc.from("messages").update({ content }).eq("id", id);
    },
  };
}

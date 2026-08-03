import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUN_WEDGE_CEILING_MS } from "@/lib/chat/run-staleness";

/**
 * tests/migration-0007.test.ts — source assertions over
 * `supabase/migrations/0007_run_in_flight.sql` (review GC-01).
 *
 * WHAT A SOURCE TEST CAN AND CANNOT DO. It cannot prove the migration behaves
 * correctly against Postgres — `scripts/debit-concurrency.ts` Scenarios 4 and 5
 * do that against the live project, and plan 03-19 owns running them. What it
 * CAN do, and what nothing else in this repo does, is pin the clauses whose
 * ABSENCE would be silent:
 *
 *   - `search_path` is part of a function definition and is silently LOST on a
 *     CREATE OR REPLACE that omits it. A definer function that loses it becomes
 *     a privilege-escalation surface, and every existing test would still pass
 *     (threat T-03-18-02).
 *   - The ORDER of the four body steps is the whole design. Move the balance
 *     read above the in-flight check and a user with a live run is told they
 *     are out of credits; move the reap below the check and a wedged row locks
 *     the chat out forever. Neither reorder changes a single grep count, so the
 *     ordering assertions below compare character offsets.
 *   - The 330-second bound must stay in lockstep with the client-side twin. It
 *     is asserted here against the imported constant, so the two layers cannot
 *     drift by editing only one file.
 */

const SQL = readFileSync(
  new URL("../supabase/migrations/0007_run_in_flight.sql", import.meta.url),
  "utf8",
);

/** Count non-overlapping matches of a global regex. */
function countOf(re: RegExp): number {
  return (SQL.match(re) ?? []).length;
}

/** The text of the single SQL statement beginning at `startIdx`, up to its `;`. */
function statementAt(startIdx: number): string {
  expect(startIdx).toBeGreaterThan(-1);
  const end = SQL.indexOf(";", startIdx);
  expect(end).toBeGreaterThan(startIdx);
  return SQL.slice(startIdx, end + 1);
}

// The four body anchors, in the order the design requires.
const REAP_IDX = SQL.indexOf("update public.runs");
const EXISTS_IDX = SQL.indexOf("if exists (");
const BALANCE_IDX = SQL.indexOf("coalesce(sum(delta), 0)");
const RUNS_INSERT_IDX = SQL.indexOf("insert into public.runs");

describe("definer posture — the privilege-escalation surface", () => {
  it("re-declares security definer on the replacement", () => {
    expect(SQL).toMatch(/^security definer$/m);
  });

  it("re-declares an EMPTY search_path (silently lost if omitted)", () => {
    expect(SQL).toMatch(/^set search_path = ''$/m);
  });

  it("replaces the function in place rather than dropping it, so grants survive", () => {
    expect(SQL).toMatch(
      /create or replace function public\.start_run\(p_user_id uuid, p_chat_id uuid, p_model_id text\)/,
    );
    expect(SQL).not.toMatch(/drop function/i);
  });

  it("keeps the signature and return type identical to migration 0002", () => {
    expect(SQL).toMatch(/\(p_user_id uuid, p_chat_id uuid, p_model_id text\)\s*\nreturns uuid/);
    expect(SQL).toMatch(/^language plpgsql$/m);
  });

  it("schema-qualifies every table it touches (required under an empty search_path)", () => {
    expect(SQL).toMatch(/public\.profiles/);
    expect(SQL).toMatch(/public\.runs/);
    expect(SQL).toMatch(/public\.credits_ledger/);
  });

  it("leaves no UNQUALIFIED reference to any of those three tables", () => {
    // `(?<!public\.)` — a bare `from runs` / `into credits_ledger` under an
    // empty search_path resolves to nothing and would break at call time, or
    // worse resolve somewhere unintended if the path were ever restored.
    expect(SQL).not.toMatch(/\b(from|into|update|join)\s+(?!public\.)(profiles|runs|credits_ledger)\b/);
  });

  it("keeps execute revoked from public and authenticated and granted to service_role only", () => {
    expect(SQL).toMatch(/revoke all on function public\.start_run\(uuid, uuid, text\) from public;/);
    expect(SQL).toMatch(
      /revoke all on function public\.start_run\(uuid, uuid, text\) from authenticated;/,
    );
    expect(SQL).toMatch(
      /grant execute on function public\.start_run\(uuid, uuid, text\) to service_role;/,
    );
  });
});

describe("refusal codes — what the route is allowed to map", () => {
  it("raises P0002 from BOTH sites: the exists check and the nested unique_violation handler", () => {
    expect(countOf(/errcode = 'P0002'/g)).toBe(2);
    expect(countOf(/raise exception 'run_in_flight'/g)).toBe(2);
  });

  it("still raises P0001 for insufficient_credits, exactly once", () => {
    expect(countOf(/errcode = 'P0001'/g)).toBe(1);
    expect(SQL).toMatch(/raise exception 'insufficient_credits' using errcode = 'P0001';/);
  });

  it("scopes the unique_violation handler to a nested block around the runs insert only", () => {
    // An outer-level handler would also catch a credits_ledger unique violation
    // and mislabel it as an in-flight run (threat T-03-18-07). The handler must
    // therefore sit BETWEEN the runs insert and the ledger debit.
    const handlerIdx = SQL.indexOf("exception when unique_violation then");
    const ledgerInsertIdx = SQL.indexOf("insert into public.credits_ledger");
    expect(handlerIdx).toBeGreaterThan(RUNS_INSERT_IDX);
    expect(ledgerInsertIdx).toBeGreaterThan(handlerIdx);
    // ...and the nested block must be opened before the insert it guards.
    const nestedBeginIdx = SQL.lastIndexOf("\n  begin\n", RUNS_INSERT_IDX);
    expect(nestedBeginIdx).toBeGreaterThan(BALANCE_IDX);
  });
});

describe("body order — the design, and the thing a grep count cannot catch", () => {
  it("locks the caller's profiles row FIRST", () => {
    const lockIdx = SQL.indexOf("for update");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(REAP_IDX);
  });

  it("reaps BEFORE the in-flight check (otherwise a wedged row is a permanent lockout)", () => {
    expect(REAP_IDX).toBeGreaterThan(-1);
    expect(REAP_IDX).toBeLessThan(EXISTS_IDX);
  });

  it("checks in-flight BEFORE reading the balance (otherwise a live run is told it is out of credits)", () => {
    expect(EXISTS_IDX).toBeGreaterThan(-1);
    expect(EXISTS_IDX).toBeLessThan(BALANCE_IDX);
  });

  it("reads the balance BEFORE opening the run (no run row without a credit behind it)", () => {
    expect(BALANCE_IDX).toBeGreaterThan(-1);
    expect(BALANCE_IDX).toBeLessThan(RUNS_INSERT_IDX);
  });

  it("debits the ledger AFTER the run row exists, so the debit can carry the run id", () => {
    expect(SQL.indexOf("insert into public.credits_ledger")).toBeGreaterThan(RUNS_INSERT_IDX);
    expect(SQL).toMatch(/'run_debit', v_run::text/);
  });

  it("refuses in-flight by chat, not by user — the check is scoped to p_chat_id", () => {
    expect(statementAt(EXISTS_IDX)).toMatch(/chat_id = p_chat_id and status = 'running'/);
  });
});

describe("the reaper — bounded, per-chat, and money-free", () => {
  it("uses the 330-second bound, in lockstep with the client-side RUN_WEDGE_CEILING_MS", () => {
    expect(RUN_WEDGE_CEILING_MS / 1000).toBe(330);
    expect(countOf(/interval '330 seconds'/g)).toBe(2); // in-function + one-time
  });

  it("scopes the in-function reap to the requested chat and treats a NULL started_at as stale", () => {
    const reap = statementAt(REAP_IDX);
    expect(reap).toMatch(/chat_id = p_chat_id/);
    expect(reap).toMatch(/status = 'running'/);
    expect(reap).toMatch(/started_at is null or started_at < now\(\) - interval '330 seconds'/);
  });

  it("writes ONLY status and ended_at — neither reap touches credits_ledger", () => {
    const inFunction = statementAt(REAP_IDX);
    const oneTime = statementAt(SQL.indexOf("update public.runs", REAP_IDX + 1));
    for (const reap of [inFunction, oneTime]) {
      expect(reap).toMatch(/set status = 'failed'/);
      expect(reap).toMatch(/ended_at = coalesce\(ended_at, now\(\)\)/);
      // Refund eligibility lives in public.refund_run and is gated on
      // first_model_call_completed; a second money path here is forbidden
      // (threat T-03-18-06).
      expect(reap).not.toMatch(/credits_ledger/);
      expect(reap).not.toMatch(/\b(insert|delete)\b/);
    }
  });

  it("runs the one-time GLOBAL reap before creating the index (or index creation fails on wedged data)", () => {
    const oneTimeIdx = SQL.indexOf("update public.runs", REAP_IDX + 1);
    const indexIdx = SQL.indexOf("create unique index");
    expect(oneTimeIdx).toBeGreaterThan(-1);
    expect(indexIdx).toBeGreaterThan(oneTimeIdx);
    // Global, not per-chat: it must clear every pre-existing wedged row.
    expect(statementAt(oneTimeIdx)).not.toMatch(/p_chat_id/);
  });
});

describe("the partial unique index — the fail-closed backstop", () => {
  it("is named runs_one_running_per_chat, is on public.runs (chat_id), and is predicated on status = 'running'", () => {
    expect(SQL).toMatch(
      /create unique index if not exists runs_one_running_per_chat\s*\n\s*on public\.runs \(chat_id\) where status = 'running';/,
    );
  });

  it("is idempotent, so a re-applied migration does not error", () => {
    expect(SQL).toMatch(/create unique index if not exists/);
  });
});

describe("additive and forward-only", () => {
  it("touches no 0001-0006 object: no alter/drop of an existing table, policy, type, or index", () => {
    expect(SQL).not.toMatch(/drop (table|policy|type|index|trigger)/i);
    expect(SQL).not.toMatch(/alter (table|type|policy)/i);
  });

  it("records the 330s/RUN_WEDGE_CEILING_MS coupling in a comment, so a future editor changes both", () => {
    expect(SQL).toMatch(/RUN_WEDGE_CEILING_MS/);
    expect(SQL).toMatch(/run-staleness\.ts/);
  });
});

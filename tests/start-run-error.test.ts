import { describe, expect, it } from "vitest";
import {
  INSUFFICIENT_CREDITS_COPY,
  RUN_IN_FLIGHT_COPY,
  mapStartRunError,
} from "@/lib/agent/start-run-error";

/**
 * tests/start-run-error.test.ts — the pure `start_run` refusal mapper (GC-01).
 *
 * TWO things are pinned here and both are security/product boundaries, not
 * style preferences:
 *
 * 1. THE COPY IS PINNED BYTE FOR BYTE. The insufficient-credits string is
 *    locked copy inherited from Phase 2 and moved (not retyped) out of
 *    `app/api/agent/run/route.ts`; a reword must break a test, not ship.
 *
 * 2. THE SIGNATURE TAKES A CODE, NEVER AN ERROR OBJECT. A PostgrestError
 *    carries `message`, `details`, `hint` and constraint names — and a
 *    constraint name can echo a user-supplied value. Keeping the parameter a
 *    bare string is what makes "no Postgres body reaches the client" a type
 *    fact rather than a code-review convention (threat T-03-18-03).
 *
 * The unknown-code cases are the load-bearing half of the mapping: anything
 * the mapper does not recognise MUST return null so the route falls through to
 * its existing generic `debit_error` branch (which logs) rather than inventing
 * user-facing copy for an error nobody has classified.
 */

describe("locked copy", () => {
  it("INSUFFICIENT_CREDITS_COPY is the exact Phase-2 string, byte for byte", () => {
    expect(INSUFFICIENT_CREDITS_COPY).toBe(
      "You are out of credits. Redeem a credit to run another research chat.",
    );
  });

  it("RUN_IN_FLIGHT_COPY is the exact GC-01 refusal string, byte for byte", () => {
    expect(RUN_IN_FLIGHT_COPY).toBe(
      "That chat already has a run in progress. Wait for it to finish, then ask again.",
    );
  });

  it("neither copy string names a table, a column, a constraint, or an id", () => {
    for (const copy of [INSUFFICIENT_CREDITS_COPY, RUN_IN_FLIGHT_COPY]) {
      expect(copy).not.toMatch(/runs|chat_id|credits_ledger|P000|23505|_uk|_once/);
    }
  });
});

describe("mapStartRunError — the two recognised refusals", () => {
  it("maps P0001 to insufficient_credits with the locked copy", () => {
    expect(mapStartRunError("P0001")).toEqual({
      code: "insufficient_credits",
      message: INSUFFICIENT_CREDITS_COPY,
    });
  });

  it("maps P0002 to run_in_flight with the in-flight copy", () => {
    expect(mapStartRunError("P0002")).toEqual({
      code: "run_in_flight",
      message: RUN_IN_FLIGHT_COPY,
    });
  });

  it("returns the copy constants themselves, so the route cannot drift from them", () => {
    expect(mapStartRunError("P0001")?.message).toBe(INSUFFICIENT_CREDITS_COPY);
    expect(mapStartRunError("P0002")?.message).toBe(RUN_IN_FLIGHT_COPY);
  });
});

describe("mapStartRunError — everything else falls through to the caller's generic branch", () => {
  it("returns null for null", () => {
    expect(mapStartRunError(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(mapStartRunError(undefined)).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(mapStartRunError("")).toBeNull();
  });

  it("returns null for P0003 (redeem_coupon's already_redeemed — a different function's code)", () => {
    expect(mapStartRunError("P0003")).toBeNull();
  });

  it("returns null for a raw 23505 — the nested handler in migration 0007 means the route must never see one, and if it does it is NOT an in-flight run", () => {
    expect(mapStartRunError("23505")).toBeNull();
  });

  it.each([
    "28000",
    "P0000",
    "p0001",
    "P00011",
    "42501",
    "insufficient_credits",
    "run_in_flight",
    " P0001",
    "P0001 ",
  ])("returns null for the unrecognised code %j", (code) => {
    expect(mapStartRunError(code)).toBeNull();
  });
});

describe("mapStartRunError — the signature is the information-disclosure boundary", () => {
  it("takes exactly one parameter", () => {
    expect(mapStartRunError.length).toBe(1);
  });

  it("cannot be satisfied by a PostgrestError-shaped object: passing one is a type error and, at runtime, maps to null", () => {
    const errorObject = {
      code: "P0002",
      message: 'duplicate key value violates unique constraint "runs_one_running_per_chat"',
      details: "Key (chat_id)=(0000) already exists.",
      hint: null,
    };
    // @ts-expect-error the parameter is a bare code string, never an error object
    expect(mapStartRunError(errorObject)).toBeNull();
  });
});

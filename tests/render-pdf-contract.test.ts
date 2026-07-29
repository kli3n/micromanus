import { describe, expect, it, vi } from "vitest";
import { renderPdfBody, POST } from "@/app/api/render-pdf/route";

/**
 * D-40 / T-3-02 — the hardened /api/render-pdf contract, unit level.
 *
 * Exercises the zod body schema directly plus the route's auth guard shape.
 * The 401 and 400 paths return BEFORE the lazy chromium import, so no
 * Chromium ever launches in tests. The 200 {error:'pdf_unavailable'} degrade
 * contract is exercised live by the deployed smoke check, not here.
 */

// Mutable auth state the mocked server client reads per call.
const authState: { userId: string | undefined } = { userId: undefined };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: authState.userId ? { id: authState.userId } : null },
      }),
    },
  }),
}));

function post(body: unknown): Request {
  return new Request("http://localhost/api/render-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = { title: "Report", markdown: "# Hello\n\nBody [1]." };

describe("renderPdfBody (zod at the boundary)", () => {
  it("accepts a valid body with sources omitted", () => {
    expect(renderPdfBody.safeParse(VALID).success).toBe(true);
  });

  it("accepts a valid body with well-formed sources", () => {
    const r = renderPdfBody.safeParse({
      ...VALID,
      sources: [{ n: 1, title: "S", url: "https://a.io" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a missing title", () => {
    expect(renderPdfBody.safeParse({ markdown: "x" }).success).toBe(false);
  });

  it("rejects an empty markdown", () => {
    expect(renderPdfBody.safeParse({ title: "T", markdown: "" }).success).toBe(false);
  });

  it("rejects markdown longer than 200000 chars", () => {
    const r = renderPdfBody.safeParse({ title: "T", markdown: "x".repeat(200_001) });
    expect(r.success).toBe(false);
  });

  it("rejects a title longer than 200 chars", () => {
    const r = renderPdfBody.safeParse({ title: "t".repeat(201), markdown: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects more than 50 sources", () => {
    const sources = Array.from({ length: 51 }, (_, i) => ({
      n: i + 1,
      title: "S",
      url: "https://a.io",
    }));
    expect(renderPdfBody.safeParse({ ...VALID, sources }).success).toBe(false);
  });

  it("rejects a non-integer n", () => {
    const r = renderPdfBody.safeParse({
      ...VALID,
      sources: [{ n: 1.5, title: "S", url: "https://a.io" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects n < 1", () => {
    const r = renderPdfBody.safeParse({
      ...VALID,
      sources: [{ n: 0, title: "S", url: "https://a.io" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("POST /api/render-pdf auth + body guards (T-3-02)", () => {
  it("returns 401 {error:'unauthenticated'} without a session — before any body work", async () => {
    authState.userId = undefined;
    const res = await POST(post(VALID));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("returns 400 {error:'bad_request'} on a zod failure", async () => {
    authState.userId = "user-1";
    const res = await POST(post({ markdown: "no title" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("returns 400 {error:'bad_request'} on a non-JSON body", async () => {
    authState.userId = "user-1";
    const res = await POST(post("not json {{{"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});

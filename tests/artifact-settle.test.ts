import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEGRADED_CARRIER_MARKDOWN_CAP,
  artifactCarrierPayload,
  insertPendingArtifact,
  settleReport,
} from "@/lib/artifacts/db";
import { parseArtifactCarrier } from "@/components/chat/ArtifactCard";
import { degradedBodyToRender } from "@/components/chat/render-rules";

/**
 * D-43/D-46 / T-3-52 — the deferred settle pipeline, driven entirely through
 * injected fetchFn/svc fakes (no network, no Chromium, no DB).
 *
 * The never-pending invariant: EVERY exit path — application/pdf success,
 * 200-JSON degrade, HTML interstitial, wrong content-type, fetch throw
 * (incl. AbortError), upload error, unexpected mid-path throw — ends with
 * BOTH the artifacts UPDATE and the carrier-message UPDATE. Content-type is
 * the branch signal, never res.ok alone (Pitfall 7).
 */

interface UpdateCall {
  values: Record<string, unknown>;
  id: string;
}

function fakeSvc(
  opts: { uploadError?: unknown; insertError?: unknown; updateError?: unknown } = {},
) {
  const calls = {
    artifactUpdates: [] as UpdateCall[],
    messageUpdates: [] as UpdateCall[],
    uploads: [] as { bucket: string; path: string; bytes: Uint8Array; opts: unknown }[],
    inserts: [] as { table: string; values: Record<string, unknown> }[],
  };
  const svc = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown>) {
          calls.inserts.push({ table, values });
          return {
            select: () => ({
              single: async () =>
                opts.insertError
                  ? { data: null, error: opts.insertError }
                  : { data: { id: "art-1" }, error: null },
            }),
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq: async (_col: string, id: string) => {
              (table === "artifacts" ? calls.artifactUpdates : calls.messageUpdates).push({
                values,
                id,
              });
              // WR-01: supabase-js RESOLVES { error } on a refusal — it never
              // throws. A fake that always resolves { error: null } is more
              // capable than reality (the entry-#8 trap) and cannot see a
              // dead resolved-error guard; `updateError` drives that path.
              return { error: opts.updateError ?? null };
            },
          };
        },
      };
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, bytes: Uint8Array, o: unknown) => {
            calls.uploads.push({ bucket, path, bytes, opts: o });
            return { error: opts.uploadError ?? null };
          },
        };
      },
    },
  };
  return { svc: svc as unknown as SupabaseClient, calls };
}

function fetchReturning(res: Response | (() => Response) | Error): typeof fetch {
  return (async () => {
    if (res instanceof Error) throw res;
    return typeof res === "function" ? res() : res;
  }) as unknown as typeof fetch;
}

const JOB = {
  artifactId: "art-1",
  carrierMsgId: "msg-1",
  title: "My Report",
  markdown: "# Report body [1]",
  sources: [{ n: 1, title: "S1", url: "https://a.io/1" }],
  userId: "u-1",
  chatId: "c-1",
};

function deps(fetchFn: typeof fetch, svc: SupabaseClient) {
  return { fetchFn, svc, origin: "https://app.example", cookie: "sb=token" };
}

/** Both settle writes happened — the card can never stick at pending. */
function expectTerminal(
  calls: ReturnType<typeof fakeSvc>["calls"],
  state: "succeeded" | "degraded",
) {
  expect(calls.artifactUpdates).toHaveLength(1);
  expect(calls.artifactUpdates[0].id).toBe("art-1");
  expect(calls.artifactUpdates[0].values.status).toBe(state);
  expect(calls.messageUpdates).toHaveLength(1);
  expect(calls.messageUpdates[0].id).toBe("msg-1");
  const payload = JSON.parse(calls.messageUpdates[0].values.content as string) as {
    kind: string;
    state: string;
    artifactId: string;
    title: string;
    markdown?: string;
  };
  expect(payload.kind).toBe("artifact");
  expect(payload.state).toBe(state === "succeeded" ? "ready" : "degraded");
  expect(payload.artifactId).toBe("art-1");
  expect(payload.title).toBe("My Report");
  // RC-02 — asserted on EVERY exit path, not in one dedicated test, because the
  // defect was that the degraded carrier carried no body on ANY of them. The
  // card's consumer chain (parseArtifactCarrier → degradedBodyToRender →
  // ChatThread's body-below block) reads `markdown` and nothing wrote it, so a
  // degrade lost the report entirely while the card claimed it was in the
  // answer above.
  if (state === "degraded") {
    expect(payload.markdown).toBe(JOB.markdown);
    // And it survives the read guard all the way to a rendered body.
    const parsed = parseArtifactCarrier(payload);
    expect(parsed?.markdown).toBe(JOB.markdown);
    expect(
      degradedBodyToRender({
        carrierMarkdown: parsed?.markdown,
        answerContent: "A short closing answer that is not the report.",
      }),
    ).toBe(JOB.markdown);
  } else {
    // The PDF itself is the artifact on the success path; a second copy of the
    // report in a Realtime broadcast would have no reader.
    expect(payload.markdown).toBeUndefined();
  }
}

describe("settleReport — every exit path is terminal (D-43/D-46, T-3-52)", () => {
  it("application/pdf + ok: uploads to {user_id}/{chat_id}/{artifact_id}.pdf with upsert, settles succeeded/ready", async () => {
    const { svc, calls } = fakeSvc();
    let requested: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      requested = { url, init };
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }) as unknown as typeof fetch;

    await settleReport(deps(fetchFn, svc), JOB);

    // Self-fetch shape: origin + route, forwarded cookie, sources in the body.
    expect(requested!.url).toBe("https://app.example/api/render-pdf");
    expect((requested!.init.headers as Record<string, string>).cookie).toBe("sb=token");
    const body = JSON.parse(requested!.init.body as string) as {
      title: string;
      markdown: string;
      sources: unknown[];
    };
    expect(body.title).toBe("My Report");
    expect(body.sources).toEqual(JOB.sources);

    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0].bucket).toBe("reports");
    expect(calls.uploads[0].path).toBe("u-1/c-1/art-1.pdf");
    expect(calls.uploads[0].opts).toMatchObject({
      contentType: "application/pdf",
      upsert: true,
    });
    expect(calls.artifactUpdates[0].values.storage_path).toBe("u-1/c-1/art-1.pdf");
    expectTerminal(calls, "succeeded");
  });

  it("200 application/json body (the render degrade contract): degraded — res.ok true is NOT success", async () => {
    const { svc, calls } = fakeSvc();
    const fetchFn = fetchReturning(
      new Response(JSON.stringify({ error: "pdf_unavailable" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await settleReport(deps(fetchFn, svc), JOB);
    expect(calls.uploads).toHaveLength(0);
    expect(calls.artifactUpdates[0].values.storage_path).toBeNull();
    expectTerminal(calls, "degraded");
  });

  it("200 text/html (deployment-protection interstitial): degraded", async () => {
    const { svc, calls } = fakeSvc();
    const fetchFn = fetchReturning(
      new Response("<html>Vercel auth</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    await settleReport(deps(fetchFn, svc), JOB);
    expect(calls.uploads).toHaveLength(0);
    expectTerminal(calls, "degraded");
  });

  it("wrong content-type (text/plain): degraded", async () => {
    const { svc, calls } = fakeSvc();
    const fetchFn = fetchReturning(
      new Response("bytes?", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    await settleReport(deps(fetchFn, svc), JOB);
    expectTerminal(calls, "degraded");
  });

  it("non-ok status even WITH a pdf content-type: degraded", async () => {
    const { svc, calls } = fakeSvc();
    const fetchFn = fetchReturning(
      new Response("err", { status: 500, headers: { "Content-Type": "application/pdf" } }),
    );
    await settleReport(deps(fetchFn, svc), JOB);
    expect(calls.uploads).toHaveLength(0);
    expectTerminal(calls, "degraded");
  });

  it("fetchFn throwing (55s AbortError timeout): degraded", async () => {
    const { svc, calls } = fakeSvc();
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    await settleReport(deps(fetchReturning(abort), svc), JOB);
    expect(calls.uploads).toHaveLength(0);
    expectTerminal(calls, "degraded");
  });

  it("storage upload error: degraded with a null storage_path", async () => {
    const { svc, calls } = fakeSvc({ uploadError: { message: "bucket unavailable" } });
    const fetchFn = fetchReturning(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    await settleReport(deps(fetchFn, svc), JOB);
    expect(calls.uploads).toHaveLength(1);
    expect(calls.artifactUpdates[0].values.storage_path).toBeNull();
    expectTerminal(calls, "degraded");
  });

  it("a REFUSED settle write resolves { error } and is LOGGED — the catch alone is dead code (WR-01)", async () => {
    // supabase-js v2 resolves { error } on a Postgres refusal (DEBUGGING-LOG
    // entry #8) — the old bare try/catch never fired, so a refused UPDATE left
    // the artifact pending forever with nothing logged. Both terminal writes
    // must still be ATTEMPTED and both refusals must reach console.error with
    // the error code only (T-03-14-01: never a body).
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { svc, calls } = fakeSvc({ updateError: { code: "42501" } });
      const fetchFn = fetchReturning(
        new Response(JSON.stringify({ error: "pdf_unavailable" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await settleReport(deps(fetchFn, svc), JOB); // must not throw
      expect(calls.artifactUpdates).toHaveLength(1);
      expect(calls.messageUpdates).toHaveLength(1);
      const logged = spy.mock.calls.map((c) => c.join(" "));
      expect(
        logged.some((l) => l.includes("artifacts settle write refused") && l.includes("42501")),
      ).toBe(true);
      expect(
        logged.some((l) => l.includes("carrier settle write refused") && l.includes("42501")),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("unexpected mid-path throw (arrayBuffer rejects): degraded, still terminal", async () => {
    const { svc, calls } = fakeSvc();
    const res = new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
    res.arrayBuffer = async () => {
      throw new Error("stream reset");
    };
    await settleReport(deps(fetchReturning(() => res), svc), JOB);
    expect(calls.uploads).toHaveLength(0);
    expectTerminal(calls, "degraded");
  });
});

describe("insertPendingArtifact (Db-wrapper shape — never throws)", () => {
  it("inserts a pending row and returns its id", async () => {
    const { svc, calls } = fakeSvc();
    const id = await insertPendingArtifact(svc, {
      runId: "run-1",
      chatId: "c-1",
      userId: "u-1",
      title: "My Report",
    });
    expect(id).toBe("art-1");
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0].table).toBe("artifacts");
    expect(calls.inserts[0].values).toMatchObject({
      run_id: "run-1",
      chat_id: "c-1",
      user_id: "u-1",
      title: "My Report",
      status: "pending",
    });
  });

  it("returns null (never throws) on an insert error", async () => {
    const { svc } = fakeSvc({ insertError: { message: "db down" } });
    await expect(
      insertPendingArtifact(svc, {
        runId: null,
        chatId: "c-1",
        userId: "u-1",
        title: "T",
      }),
    ).resolves.toBeNull();
  });
});

/**
 * REGRESSION: review RC-02 — the degraded artifact path rendered nothing below
 * the card and told the user the report was in the answer above.
 *
 * `degradedBodyToRender` was correct; `artifactCarrierPayload` returned exactly
 * `{id, kind, state, artifactId, title}` at all three of its call sites, so the
 * `markdown` the consumer chain reads was ALWAYS undefined. Every degraded
 * artifact therefore hit `if (typeof carrier !== "string") return null`, the
 * body-below block was dead code in production, and the card fell to its
 * "…in the answer above." sub-line — which the system prompt actively
 * contradicts: the model is told to pass the complete report body to
 * `create_pdf_report` and then "simply continue to your final answer", and the
 * loop only overwrites a report body shorter than 200 characters. A 6,000-char
 * report with a 600-char answer degraded to no PDF, no report, and confident
 * copy.
 *
 * These assertions are about the PRODUCER, which is where the fix belongs. The
 * consumer half already had a passing suite — that is precisely why the gap
 * survived a full review round.
 */
describe("artifactCarrierPayload — the degraded carrier carries the report (RC-02)", () => {
  const ID = "11111111-1111-1111-1111-111111111111";
  const BODY = "# Full report\n\nMuch longer than the closing answer.";

  it("attaches the body on a degraded carrier", () => {
    const parsed = JSON.parse(
      artifactCarrierPayload(ID, "T", "degraded", BODY),
    ) as Record<string, unknown>;
    expect(parsed.markdown).toBe(BODY);
    // …and the read guard passes it through, so a body actually renders.
    expect(parseArtifactCarrier(parsed)?.markdown).toBe(BODY);
  });

  it("omits the body on pending and ready carriers even when one is supplied", () => {
    for (const state of ["pending", "ready"] as const) {
      const parsed = JSON.parse(
        artifactCarrierPayload(ID, "T", state, BODY),
      ) as Record<string, unknown>;
      expect(parsed.markdown, `state=${state}`).toBeUndefined();
      expect("markdown" in parsed, `state=${state}`).toBe(false);
    }
  });

  it("omits the key entirely rather than emitting null/empty when no body exists", () => {
    for (const markdown of [undefined, ""]) {
      const parsed = JSON.parse(
        artifactCarrierPayload(ID, "T", "degraded", markdown),
      ) as Record<string, unknown>;
      expect("markdown" in parsed, `markdown=${JSON.stringify(markdown)}`).toBe(
        false,
      );
    }
  });

  it("keeps the pre-RC-02 five keys byte-identical when no body is attached", () => {
    // The pending insert and the ready settle must not change shape at all.
    expect(artifactCarrierPayload(ID, "T", "pending")).toBe(
      JSON.stringify({
        id: `artifact-${ID}`,
        kind: "artifact",
        state: "pending",
        artifactId: ID,
        title: "T",
      }),
    );
  });

  it("caps the body so one messages row cannot carry an unbounded report", () => {
    const huge = "x".repeat(DEGRADED_CARRIER_MARKDOWN_CAP + 500);
    const parsed = JSON.parse(
      artifactCarrierPayload(ID, "T", "degraded", huge),
    ) as { markdown: string };
    expect(parsed.markdown).toHaveLength(DEGRADED_CARRIER_MARKDOWN_CAP);
  });

  it("EC-06 stays closed: a body trim-equal to the answer still renders nothing below", () => {
    const answer = "The report and the answer are the same text.";
    const parsed = JSON.parse(
      artifactCarrierPayload(ID, "T", "degraded", `\n  ${answer}  \n`),
    ) as { markdown: string };
    expect(
      degradedBodyToRender({
        carrierMarkdown: parsed.markdown,
        answerContent: answer,
      }),
    ).toBeNull();
  });
});

describe("every producer call site passes the body where one exists (RC-02)", () => {
  const DB_SRC = readFileSync(
    new URL("../lib/artifacts/db.ts", import.meta.url),
    "utf8",
  );
  const ROUTE_SRC = readFileSync(
    new URL("../app/api/agent/run/route.ts", import.meta.url),
    "utf8",
  );

  it("the settle write passes job.markdown", () => {
    expect(DB_SRC).toMatch(
      /artifactCarrierPayload\(\s*job\.artifactId,\s*job\.title,\s*state === "succeeded" \? "ready" : "degraded",\s*job\.markdown,/,
    );
  });

  it("the route's degraded fallback passes q.markdown", () => {
    // The unexpected-throw path in the deferred-render task: the settle never
    // ran, so this row is the user's only remaining route to the report.
    expect(ROUTE_SRC).toMatch(
      /artifactCarrierPayload\(\s*artifactId,\s*q\.title,\s*"degraded",\s*q\.markdown,/,
    );
  });

  it("the route's PENDING insert deliberately passes no body", () => {
    expect(ROUTE_SRC).toMatch(
      /artifactCarrierPayload\(artifactId, q\.title, "pending"\)/,
    );
  });

  it("has exactly three producer call sites, so a fourth cannot be added unnoticed", () => {
    const sites = [
      ...(DB_SRC.match(/artifactCarrierPayload\(/g) ?? []),
      ...(ROUTE_SRC.match(/artifactCarrierPayload\(/g) ?? []),
    ];
    // db.ts: the declaration + the settle write. route.ts: pending + degraded.
    expect(sites).toHaveLength(4);
  });
});

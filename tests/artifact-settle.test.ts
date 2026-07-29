import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { insertPendingArtifact, settleReport } from "@/lib/artifacts/db";

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

function fakeSvc(opts: { uploadError?: unknown; insertError?: unknown } = {}) {
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
              return { error: null };
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
  };
  expect(payload.kind).toBe("artifact");
  expect(payload.state).toBe(state === "succeeded" ? "ready" : "degraded");
  expect(payload.artifactId).toBe("art-1");
  expect(payload.title).toBe("My Report");
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

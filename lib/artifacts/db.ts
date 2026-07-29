/**
 * lib/artifacts/db.ts — artifact row insert + deferred settle pipeline.
 *
 * SERVER-ONLY (CM-8): operates on the service-role client from inside the
 * agent route's waitUntil task — the SSE response has already closed, so no
 * user JWT exists. Never import this from anything client-reachable.
 *
 * DESIGN (D-43/D-44/D-46/D-47):
 *  - The render happens over internal HTTP to /api/render-pdf (the D-12
 *    quarantine — Chromium never enters the agent bundle), with the origin +
 *    cookie captured at request time (Correction C3: NEVER a Vercel URL env
 *    var, which 401s under Standard Deployment Protection).
 *  - The branch signal is the response CONTENT-TYPE, never res.ok alone: the
 *    render route's degrade is a 200 JSON body, and a deployment-protection
 *    interstitial is a 200 text/html body (Pitfall 7).
 *  - EVERY exit path lands on a terminal artifacts.status AND a terminal
 *    carrier-message state — a card can never stick at pending (T-3-52). The
 *    finally block owns both writes, each individually guarded.
 *  - fetchFn/svc are injected so tests drive every exit path without network.
 *
 * Error hygiene: causes are logged server-side only, with the [artifact] tag
 * and error NAMES — never bodies (they can carry fetched page text).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PendingArtifact {
  runId: string | null;
  chatId: string;
  userId: string;
  title: string;
}

/**
 * Insert the pending artifacts row BEFORE the render starts, so a cancelled
 * waitUntil (function timeout — AI-SPEC Pitfall 10) still leaves reopenable
 * state. Db-wrapper shape: console.error + null on failure, never throw.
 */
export async function insertPendingArtifact(
  svc: SupabaseClient,
  a: PendingArtifact,
): Promise<string | null> {
  const { data, error } = await svc
    .from("artifacts")
    .insert({
      run_id: a.runId,
      chat_id: a.chatId,
      user_id: a.userId,
      title: a.title,
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error(
      "[artifact] insert pending failed:",
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : "error",
    );
    return null;
  }
  return data.id as string;
}

export interface SettleDeps {
  fetchFn: typeof fetch;
  svc: SupabaseClient;
  origin: string;
  cookie: string;
}

export interface SettleJob {
  artifactId: string;
  carrierMsgId: string;
  title: string;
  markdown: string;
  sources: { n: number; title: string; url: string }[];
  userId: string;
  chatId: string;
}

/** The {kind:'artifact'} carrier payload (03-05 interface contract). */
export function artifactCarrierPayload(
  artifactId: string,
  title: string,
  state: "pending" | "ready" | "degraded",
): string {
  return JSON.stringify({
    id: `artifact-${artifactId}`,
    kind: "artifact",
    state,
    artifactId,
    title,
  });
}

/**
 * Render → store → settle. Runs after the run reached terminal, inside the
 * existing waitUntil task. Never throws.
 */
export async function settleReport(deps: SettleDeps, job: SettleJob): Promise<void> {
  let state: "succeeded" | "degraded" = "degraded";
  let storagePath: string | null = null;
  try {
    const res = await deps.fetchFn(`${deps.origin}/api/render-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: deps.cookie },
      body: JSON.stringify({
        title: job.title,
        markdown: job.markdown,
        sources: job.sources,
      }),
      // The render route is maxDuration 60; a hung render must surface as a
      // degrade, not hang the platform function (Pitfall 6).
      signal: AbortSignal.timeout(55_000),
    });
    // CONTENT-TYPE is the signal (Pitfall 7): application/pdf → upload;
    // application/json → the documented degrade; text/html → an auth
    // interstitial; anything else → degrade. res.ok alone is NOT success.
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok && ct.includes("application/pdf")) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const path = `${job.userId}/${job.chatId}/${job.artifactId}.pdf`;
      const { error } = await deps.svc.storage
        .from("reports")
        .upload(path, bytes, { contentType: "application/pdf", upsert: true });
      if (!error) {
        state = "succeeded";
        storagePath = path;
      } else {
        console.error(
          "[artifact] upload failed:",
          error instanceof Error ? error.name : "storage_error",
        );
      }
    } else {
      console.error("[artifact] render did not return a PDF:", res.status, ct);
    }
  } catch (err) {
    console.error(
      "[artifact] render failed:",
      err instanceof Error ? err.name : "error",
    );
  } finally {
    // EVERY path lands on a terminal status — the card can never stick at
    // pending. Each write is guarded so one failing cannot skip the other.
    try {
      await deps.svc
        .from("artifacts")
        .update({ status: state, storage_path: storagePath })
        .eq("id", job.artifactId);
    } catch (err) {
      console.error(
        "[artifact] artifacts settle write failed:",
        err instanceof Error ? err.name : "error",
      );
    }
    try {
      if (job.carrierMsgId) {
        await deps.svc
          .from("messages")
          .update({
            content: artifactCarrierPayload(
              job.artifactId,
              job.title,
              state === "succeeded" ? "ready" : "degraded",
            ),
          })
          .eq("id", job.carrierMsgId); // Realtime UPDATE → the card settles
      }
    } catch (err) {
      console.error(
        "[artifact] carrier settle write failed:",
        err instanceof Error ? err.name : "error",
      );
    }
  }
}

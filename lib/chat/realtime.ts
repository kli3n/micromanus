import { createClient } from "@/lib/supabase/client";

/**
 * lib/chat/realtime.ts — the ONE place the chat `postgres_changes` channel is
 * constructed, authorized, and observed (CHAT-08).
 *
 * WHY THIS MODULE EXISTS (gap G-1, `03-UAT.md` test 7). A tab reopened mid-run
 * used to freeze: no tool rows, no iteration movement, then a jump to the final
 * state when the 4s backstop poll saw a terminal run status. The handlers were
 * never the problem — the JOIN was.
 *
 * `public.messages` and `public.runs` are RLS-protected with
 * `(select auth.uid()) = user_id` (0002_chat_agent.sql:94,111), and RLS-aware
 * Realtime authorizes every change against the JWT the channel joined with.
 * In @supabase/realtime-js 2.110.7, `RealtimeChannel.subscribe()` snapshots the
 * token SYNCHRONOUSLY into the join payload:
 *
 *     if (this.socket.accessTokenValue) {
 *       accessTokenPayload.access_token = this.socket.accessTokenValue
 *     }                                   // RealtimeChannel.ts:395-397
 *
 * `accessTokenValue` is only populated once `_performAuth` has AWAITED the
 * session (RealtimeClient.ts:615-618, :636-637). @supabase/ssr's
 * `createBrowserClient` passes no `accessToken` option, so the token arrives
 * only via the async `onAuthStateChange('INITIAL_SESSION')` listener
 * (supabase-js SupabaseClient `_listenForAuthEvents` / `_handleTokenChanged`).
 * A `.subscribe()` issued in the same tick as `createClient()` therefore raced
 * that resolution and routinely joined with NO access_token — `auth.uid()` is
 * NULL inside the policy, so every change for those two tables was filtered out
 * server-side. The channel was alive and silent, which is why nothing appeared
 * in any log and why the initiating tab (fed by SSE, not Realtime) never saw it.
 *
 * The fix is ordering, not new machinery: resolve the session, hand the token to
 * the realtime transport, and only THEN join. Pinned by an ordering assertion in
 * tests/chat-realtime.test.ts.
 *
 * D-25/D-26: nothing here renders, sets React state, or retries by hand. A
 * failed join produces exactly one tagged console line and supabase-js's own
 * backoff governs reconnection (T-03-08-03: a hand-rolled retry against an
 * RLS-rejecting socket is the larger risk).
 *
 * SECURITY (T-03-08-01/02): the only credential this module touches is the
 * signed-in user's OWN access token, read from the cookie session. A
 * service-role key must never reach this module — it is browser-reachable. The
 * status log carries the status string and the chat id only: no token, no
 * session object, no row payload.
 */

/** The `messages` row shape the thread consumes (id + role + content only). */
export interface ChatMessageRow {
  id: string;
  role: string;
  content: string | null;
}

/** The `runs` row shape the meter/settle logic consumes. */
export interface ChatRunRow {
  status?: string;
  iterations?: number;
  started_at?: string;
}

// ---- Structural client types so the test seam can inject a fake client. ----
// Mirrors the `_clientFactory` convention in lib/agent/models/anthropic.ts.
interface ChannelLike {
  on(
    type: string,
    filter: Record<string, unknown>,
    cb: (payload: { new: unknown }) => void,
  ): ChannelLike;
  subscribe(cb: (status: string) => void): ChannelLike;
}
interface SessionLike {
  access_token?: string;
}
interface ChatRealtimeClientLike {
  auth: {
    getSession(): Promise<{ data: { session: SessionLike | null } }>;
    onAuthStateChange(
      cb: (event: string, session: SessionLike | null) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
  };
  realtime: { setAuth(token: string): Promise<void> | void };
  channel(name: string): ChannelLike;
  removeChannel(channel: ChannelLike): unknown;
}

export interface SubscribeChatChannelOptions {
  /** The chat whose rows this channel delivers; also the filter value. */
  chatId: string;
  /** Called for every `messages` INSERT and UPDATE row. */
  onMessageRow: (row: ChatMessageRow) => void;
  /** Called for every `runs` UPDATE row. */
  onRunRow: (row: ChatRunRow | null) => void;
  /**
   * Called once per non-`SUBSCRIBED` subscribe status. Defaults to a single
   * tagged `console.error`. Receives the status string and the chat id ONLY.
   */
  onStatusError?: (status: string, chatId: string) => void;
  /** Test seam: inject a fake client (tests/chat-realtime.test.ts). */
  _clientFactory?: () => unknown;
}

function defaultStatusError(status: string, chatId: string): void {
  // Permanent visibility for a channel that never joins. `.subscribe()` without
  // a callback swallows CHANNEL_ERROR / TIMED_OUT / CLOSED entirely — including
  // a server-side REJECTED postgres_changes binding, which unsubscribes and
  // errors the channel (realtime-js RealtimeChannel.ts:469-473). Status + chat
  // id only (T-03-08-02).
  console.error("[chat-realtime] channel status", status, chatId);
}

/**
 * Join the chat channel for `chatId` and stream its rows to the callbacks.
 * Returns a teardown function; safe to call more than once, and safe to call
 * before the join has completed (it cancels the pending join instead).
 */
export function subscribeChatChannel(opts: SubscribeChatChannelOptions): () => void {
  const { chatId, onMessageRow, onRunRow } = opts;
  const onStatusError = opts.onStatusError ?? defaultStatusError;
  const client = (
    opts._clientFactory ? opts._clientFactory() : createClient()
  ) as unknown as ChatRealtimeClientLike;

  let channel: ChannelLike | null = null;
  let torn = false;

  // Keep the transport token current for the life of the subscription. A
  // research run can span a token refresh (runs are minutes long, access tokens
  // are short-lived); without this the socket would keep rejoining with a stale
  // JWT and go silent mid-run for exactly the same RLS reason as the original
  // bug. supabase-js's own `_handleTokenChanged` also does this, so a duplicate
  // `setAuth` with an unchanged value is a documented no-op
  // (RealtimeClient.ts:636 guards on `accessTokenValue != tokenToSend`).
  let authSub: { unsubscribe(): void } | null = null;
  try {
    authSub = client.auth.onAuthStateChange((_event, session) => {
      const next = session?.access_token;
      // Never await inside an onAuthStateChange callback (supabase-js deadlock
      // guidance). setAuth is a transport call, not an auth call.
      if (next) void Promise.resolve(client.realtime.setAuth(next)).catch(() => {});
    }).data.subscription;
  } catch {
    /* no auth listener available — the initial join below still works */
  }

  const join = async (): Promise<void> => {
    // (1) Resolve the signed-in user's own access token FIRST.
    let token: string | undefined;
    try {
      const { data } = await client.auth.getSession();
      token = data?.session?.access_token;
    } catch {
      // A signed-out or mid-refresh tab must degrade, never crash the thread.
      token = undefined;
    }
    if (torn) return;

    // (2) Hand it to the realtime transport BEFORE the channel exists, so
    //     subscribe()'s synchronous accessTokenValue snapshot cannot miss it.
    if (token) {
      try {
        await client.realtime.setAuth(token);
      } catch {
        /* transport will fall back to the callback-based token */
      }
    }
    if (torn) return;

    // (3) Only now join. Binding triples and filter strings are VERBATIM from
    //     the pre-fix ChatThread effect — this module changed how the channel is
    //     joined and observed, never what the handlers do with a row.
    channel = client
      .channel(`chat:${chatId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `chat_id=eq.${chatId}`,
        },
        (payload) => onMessageRow(payload.new as ChatMessageRow),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `chat_id=eq.${chatId}`,
        },
        (payload) => onMessageRow(payload.new as ChatMessageRow),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "runs",
          filter: `chat_id=eq.${chatId}`,
        },
        (payload) => onRunRow(payload.new as ChatRunRow | null),
      )
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") onStatusError(status, chatId);
      });
  };
  void join();

  return () => {
    if (torn) return; // idempotent — a double unmount must not double-remove
    torn = true;
    try {
      authSub?.unsubscribe();
    } catch {
      /* already gone */
    }
    if (channel) client.removeChannel(channel);
  };
}

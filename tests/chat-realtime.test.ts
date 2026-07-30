import { describe, expect, it } from "vitest";
import {
  subscribeChatChannel,
  type ChatMessageRow,
  type ChatRunRow,
} from "@/lib/chat/realtime";

/**
 * tests/chat-realtime.test.ts — pins the chat Realtime JOIN CONTRACT (CHAT-08, G-1).
 *
 * The G-1 freeze (a tab reopened mid-run receives nothing until the run ends) was
 * NOT a handler bug — the handlers were fine. It was a join-time ordering bug:
 * `public.messages` and `public.runs` are RLS-protected with
 * `(select auth.uid()) = user_id`, and RealtimeChannel.subscribe() snapshots
 * `socket.accessTokenValue` SYNCHRONOUSLY into the join payload
 * (@supabase/realtime-js 2.110.7, RealtimeChannel.ts:395-397). A `.subscribe()`
 * issued in the same tick as `createClient()` therefore joins with no
 * access_token, `auth.uid()` is NULL inside the policy, and every change for
 * those two tables is filtered out server-side. The channel is alive and silent.
 *
 * That invariant is invisible in the type system and invisible on the initiating
 * tab (which is fed by SSE, not Realtime), so it is pinned here by CALL ORDER
 * against a fake client rather than by any assertion about rendered output.
 */

const CHAT_ID = "11111111-1111-1111-1111-111111111111";

interface Binding {
  type: string;
  filter: Record<string, unknown>;
  cb: (payload: { new: unknown }) => void;
}

/** Lets the module's internal `await getSession()` / `await setAuth()` settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeFakeClient(
  opts: { accessToken?: string | null; getSessionThrows?: boolean } = {},
) {
  /** Ordered transcript of every call the module makes on the client. */
  const log: string[] = [];
  const bindings: Binding[] = [];
  const removed: unknown[] = [];
  const channels: unknown[] = [];
  const authCbs: Array<
    (event: string, session: { access_token?: string } | null) => void
  > = [];
  let statusCb: ((status: string) => void) | undefined;
  let unsubscribeCount = 0;

  const channel = {
    on(type: string, filter: Record<string, unknown>, cb: (p: { new: unknown }) => void) {
      log.push(`on:${type}`);
      bindings.push({ type, filter, cb });
      return channel;
    },
    subscribe(cb: (status: string) => void) {
      log.push("subscribe");
      statusCb = cb;
      return channel;
    },
  };

  const client = {
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async getSession() {
        log.push("getSession");
        if (opts.getSessionThrows) throw new Error("session read failed");
        const token = opts.accessToken === undefined ? "jwt-abc" : opts.accessToken;
        return { data: { session: token ? { access_token: token } : null } };
      },
      onAuthStateChange(
        cb: (event: string, session: { access_token?: string } | null) => void,
      ) {
        log.push("onAuthStateChange");
        authCbs.push(cb);
        return {
          data: {
            subscription: {
              unsubscribe() {
                unsubscribeCount += 1;
              },
            },
          },
        };
      },
    },
    realtime: {
      setAuth(token: string) {
        log.push(`setAuth:${token}`);
        return Promise.resolve();
      },
    },
    channel(name: string) {
      log.push(`channel:${name}`);
      channels.push(channel);
      return channel;
    },
    removeChannel(c: unknown) {
      log.push("removeChannel");
      removed.push(c);
    },
  };

  return {
    client,
    log,
    bindings,
    removed,
    channels,
    statusCb: () => statusCb,
    fireAuth: (event: string, session: { access_token?: string } | null) =>
      authCbs.forEach((cb) => cb(event, session)),
    unsubscribeCount: () => unsubscribeCount,
  };
}

function subscribeWith(
  fake: ReturnType<typeof makeFakeClient>,
  over: {
    onMessageRow?: (row: ChatMessageRow) => void;
    onRunRow?: (row: ChatRunRow | null) => void;
    onStatusError?: (status: string, chatId: string) => void;
  } = {},
) {
  return subscribeChatChannel({
    chatId: CHAT_ID,
    onMessageRow: over.onMessageRow ?? (() => {}),
    onRunRow: over.onRunRow ?? (() => {}),
    onStatusError: over.onStatusError ?? (() => {}),
    _clientFactory: () => fake.client,
  });
}

describe("subscribeChatChannel — RLS join order (G-1 root cause)", () => {
  it("hands the access token to the realtime transport BEFORE subscribe() is called", async () => {
    const fake = makeFakeClient();
    subscribeWith(fake);
    await flush();

    const authIdx = fake.log.indexOf("setAuth:jwt-abc");
    const subIdx = fake.log.indexOf("subscribe");
    const channelIdx = fake.log.indexOf(`channel:chat:${CHAT_ID}`);

    // Ordering assertion over the recorded transcript — NOT two independent
    // "was called" checks, which would pass against the pre-fix wiring's race.
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(subIdx);
    // Stronger: the token lands before the channel even exists, so the
    // synchronous accessTokenValue snapshot inside subscribe() cannot miss it.
    expect(authIdx).toBeLessThan(channelIdx);
    expect(fake.log.indexOf("getSession")).toBeLessThan(authIdx);
  });

  it("keeps the transport token current on TOKEN_REFRESHED so a long run does not go silent", async () => {
    const fake = makeFakeClient();
    subscribeWith(fake);
    await flush();

    fake.fireAuth("TOKEN_REFRESHED", { access_token: "jwt-fresh" });
    await flush();

    expect(fake.log).toContain("setAuth:jwt-fresh");
    // The refresh must NOT rebuild the channel (no duplicate bindings).
    expect(fake.bindings).toHaveLength(3);
    expect(fake.channels).toHaveLength(1);
  });
});

describe("subscribeChatChannel — binding contract (must not drift)", () => {
  it("registers exactly three postgres_changes bindings with the expected event/schema/table triples", async () => {
    const fake = makeFakeClient();
    subscribeWith(fake);
    await flush();

    expect(fake.bindings).toHaveLength(3);
    expect(fake.bindings.every((b) => b.type === "postgres_changes")).toBe(true);
    expect(
      fake.bindings.map((b) => [b.filter.event, b.filter.schema, b.filter.table]),
    ).toEqual([
      ["INSERT", "public", "messages"],
      ["UPDATE", "public", "messages"],
      ["UPDATE", "public", "runs"],
    ]);
  });

  it("gives every binding the filter string chat_id=eq.<chat id>", async () => {
    const fake = makeFakeClient();
    subscribeWith(fake);
    await flush();

    for (const b of fake.bindings) {
      // Pinned against the literal uuid so a template-string regression
      // (e.g. `chat_id=eq.[object Object]` or a stale closure id) is caught.
      expect(b.filter.filter).toBe("chat_id=eq.11111111-1111-1111-1111-111111111111");
      expect(b.filter.filter).toBe(`chat_id=eq.${CHAT_ID}`);
    }
  });

  it("routes message rows to onMessageRow and run rows to onRunRow", async () => {
    const messageRows: ChatMessageRow[] = [];
    const runRows: Array<ChatRunRow | null> = [];
    const fake = makeFakeClient();
    subscribeWith(fake, {
      onMessageRow: (row) => messageRows.push(row),
      onRunRow: (row) => runRows.push(row),
    });
    await flush();

    fake.bindings[0].cb({ new: { id: "m1", role: "assistant", content: "hi" } });
    fake.bindings[1].cb({ new: { id: "m1", role: "assistant", content: "hi there" } });
    fake.bindings[2].cb({ new: { status: "running", iterations: 3 } });

    expect(messageRows).toEqual([
      { id: "m1", role: "assistant", content: "hi" },
      { id: "m1", role: "assistant", content: "hi there" },
    ]);
    expect(runRows).toEqual([{ status: "running", iterations: 3 }]);
  });
});

describe("subscribeChatChannel — join observability (suspect 5)", () => {
  it("calls the injected error logger exactly once for a non-SUBSCRIBED status and does not throw", async () => {
    const errors: Array<[string, string]> = [];
    const fake = makeFakeClient();
    subscribeWith(fake, {
      onStatusError: (status, chatId) => errors.push([status, chatId]),
    });
    await flush();

    const cb = fake.statusCb();
    expect(cb).toBeTypeOf("function");
    expect(() => cb!("CHANNEL_ERROR")).not.toThrow();
    expect(errors).toEqual([["CHANNEL_ERROR", CHAT_ID]]);
  });

  it("stays silent on SUBSCRIBED (a healthy join logs nothing)", async () => {
    const errors: Array<[string, string]> = [];
    const fake = makeFakeClient();
    subscribeWith(fake, {
      onStatusError: (status, chatId) => errors.push([status, chatId]),
    });
    await flush();

    fake.statusCb()!("SUBSCRIBED");
    expect(errors).toHaveLength(0);
  });
});

describe("subscribeChatChannel — teardown", () => {
  it("removes the channel it created exactly once and is safe to call twice", async () => {
    const fake = makeFakeClient();
    const teardown = subscribeWith(fake);
    await flush();

    teardown();
    teardown();

    expect(fake.removed).toHaveLength(1);
    expect(fake.removed[0]).toBe(fake.channels[0]);
    expect(fake.unsubscribeCount()).toBe(1);
  });

  it("never joins when torn down before the session resolves", async () => {
    const fake = makeFakeClient();
    const teardown = subscribeWith(fake);
    teardown(); // synchronous unmount, before the awaited getSession settles
    await flush();

    expect(fake.log).not.toContain("subscribe");
    expect(fake.channels).toHaveLength(0);
    expect(fake.removed).toHaveLength(0);
  });
});

describe("subscribeChatChannel — degrade without a session", () => {
  it("returns a working teardown and still subscribes when no access token exists", async () => {
    const fake = makeFakeClient({ accessToken: null });
    const teardown = subscribeWith(fake);
    await flush();

    expect(fake.log.some((l) => l.startsWith("setAuth:"))).toBe(false);
    expect(fake.log).toContain("subscribe");
    expect(fake.bindings).toHaveLength(3);
    expect(() => teardown()).not.toThrow();
    expect(fake.removed).toHaveLength(1);
  });

  it("does not throw when the session read itself fails", async () => {
    const fake = makeFakeClient({ getSessionThrows: true });
    let teardown: (() => void) | undefined;
    expect(() => {
      teardown = subscribeWith(fake);
    }).not.toThrow();
    await flush();

    expect(fake.log).toContain("subscribe");
    expect(() => teardown!()).not.toThrow();
    expect(fake.removed).toHaveLength(1);
  });
});

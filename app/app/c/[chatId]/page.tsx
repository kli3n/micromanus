import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isRunWedged } from "@/lib/chat/run-staleness";
import { ChatThread, type ThreadMessage } from "@/components/ChatThread";

/**
 * /app/c/[chatId] — the research chat route (CHAT-03/05), plus the `new`
 * compose sentinel /app/c/new (D-11 route reconciliation: the canonical path is
 * /app/c/[chatId], never /app/chat/[id]).
 *
 * Async server component (RSC). The (app) layout is the real auth boundary; this
 * page re-derives `userId` (getClaims -> getUser) only to scope its RLS reads:
 *   - balance = SUM(credits_ledger.delta) for the composer's disabled-at-0 state;
 *   - for the `new` sentinel: compose mode, empty history, `initialModelId` from
 *     ?model (the 02-03 ModelPicker seam);
 *   - otherwise: the RLS-scoped chats row (title + model_id) + full ordered
 *     message history, handed to <ChatThread>. A chat not owned by the caller is
 *     invisible under RLS -> redirect('/app').
 */
export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ chatId: string }>;
  searchParams: Promise<{ model?: string }>;
}) {
  const { chatId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const supabaseAuth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{
      data: { claims?: { sub?: string } } | null;
    }>;
  };
  let userId: string | undefined;
  if (typeof supabaseAuth.getClaims === "function") {
    const { data } = await supabaseAuth.getClaims();
    userId = data?.claims?.sub;
  } else {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id;
  }
  if (!userId) redirect("/");

  // Balance = SUM(credits_ledger.delta) (RLS-scoped + explicit user filter).
  const { data: ledgerRows } = await supabase
    .from("credits_ledger")
    .select("delta")
    .eq("user_id", userId);
  const balance = (ledgerRows ?? []).reduce(
    (sum, r) => sum + (r.delta ?? 0),
    0,
  );

  // Compose sentinel: a brand-new chat picks up the model from ?model (02-03).
  if (chatId === "new") {
    return (
      <ChatThread
        chatId={null}
        initialMessages={[]}
        modelId={sp.model ?? null}
        balance={balance}
        isNew
      />
    );
  }

  const { data: chat } = await supabase
    .from("chats")
    .select("id, model_id, title")
    .eq("id", chatId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!chat) redirect("/app");

  const { data: msgs } = await supabase
    .from("messages")
    .select("id, role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  const initialMessages: ThreadMessage[] = (msgs ?? []).map((m) => ({
    id: m.id as string,
    role: m.role as string,
    content: (m.content as string) ?? "",
  }));

  // Terminal-once contract: while the latest run is still executing, its
  // assistant row is EMPTY by design (no partial flushes ever hit the DB).
  // Surface that row's id so a refreshed/reopened tab renders the same
  // "Researching…" placeholder as the initiating tab instead of a blank gap;
  // the Realtime terminal UPDATE then fills it in one shot.
  //
  // BOUNDED (review GW-02). `pendingAssistantId` is one of the three
  // `isRunInFlight` signals and the ONLY one that survives a reload, so minting
  // it unconditionally from `status='running'` means a run that never reaches a
  // terminal status — a hard kill at the 300s Fluid Compute ceiling, an evicted
  // `waitUntil` task, or a Postgres refusal that survives both terminal-write
  // attempts (GW-01) — holds this chat's composer disabled FOREVER, spinning,
  // with no reason shown. `isRunWedged` bounds it by `RUN_WEDGE_CEILING_MS`
  // (330s > the 300s platform ceiling, so no live run can reach it) HERE, at the
  // minting point, where the authoritative `started_at` is in hand. Exactly one
  // of the two ids is ever set: a wedged run releases the guard and instead
  // surfaces the explanatory notice to the client.
  //
  // `iterations` + `started_at` are selected for the RUN METER (03-UAT test 7).
  // The persisted kind:"meter" carrier row is written ONCE at loop start, with
  // {state:"running", startedAt} and deliberately no count — the count lives on
  // `runs.iterations`, rewritten per pass. Without seeding it here a reopened
  // tab starts at 0 and can only be corrected by the NEXT Realtime `runs`
  // UPDATE; because the loop writes nothing to Postgres while a model call is
  // streaming, that is 3-17s away mid-run and NEVER arrives if the reload lands
  // in the final synthesis turn (the only remaining `runs` write there is the
  // terminal setRunStatus). The meter then read a false "iteration 0/12" for the
  // whole rest of the run — measured: DB iterations=2 vs DOM 0/12 at the reload
  // frame, plus a 21s all-silent tail window. Seeding makes the FIRST painted
  // frame authoritative.
  let pendingAssistantId: string | null = null;
  let wedgedAssistantId: string | null = null;
  let initialRunMeter: { iterations: number; startedAt?: string } | null = null;
  const { data: latestRun } = await supabase
    .from("runs")
    .select("status, started_at, iterations")
    .eq("chat_id", chatId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestRun?.status === "running") {
    const lastEmptyAssistant = [...initialMessages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content.length === 0);
    const emptyAssistantId = lastEmptyAssistant?.id ?? null;
    const wedged = isRunWedged({
      status: latestRun.status as string | null,
      startedAt: latestRun.started_at as string | null,
      now: Date.now(),
    });
    if (wedged) wedgedAssistantId = emptyAssistantId;
    else pendingAssistantId = emptyAssistantId;
    // Seeded ONLY for a running run: a terminal run's count comes from the
    // settled meter carrier payload, which already carries server-computed
    // iterations + elapsedMs.
    initialRunMeter = {
      iterations: (latestRun.iterations as number | null) ?? 0,
      startedAt: (latestRun.started_at as string | null) ?? undefined,
    };
  }

  return (
    <ChatThread
      chatId={chatId}
      initialMessages={initialMessages}
      modelId={chat.model_id as string}
      balance={balance}
      isNew={false}
      initialPendingAssistantId={pendingAssistantId}
      initialWedgedAssistantId={wedgedAssistantId}
      initialRunMeter={initialRunMeter}
    />
  );
}

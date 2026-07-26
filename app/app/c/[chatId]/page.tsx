import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
  let pendingAssistantId: string | null = null;
  const { data: latestRun } = await supabase
    .from("runs")
    .select("status")
    .eq("chat_id", chatId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestRun?.status === "running") {
    const lastEmptyAssistant = [...initialMessages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content.length === 0);
    pendingAssistantId = lastEmptyAssistant?.id ?? null;
  }

  return (
    <ChatThread
      chatId={chatId}
      initialMessages={initialMessages}
      modelId={chat.model_id as string}
      balance={balance}
      isNew={false}
      initialPendingAssistantId={pendingAssistantId}
    />
  );
}

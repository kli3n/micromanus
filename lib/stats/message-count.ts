/**
 * lib/stats/message-count.ts — the per-chat conversation-turn counter for
 * /app/stats (STAT-02; review WR-06).
 *
 * WHY THIS EXISTS: the `messages` table carries far more than conversation. A
 * single research run writes one insert plus one status update per tool call,
 * plus the run-meter carrier, the plan card and the artifact carrier — all as
 * `role='tool'` rows in the same table. The stats page used to increment for
 * every row, so a 2-turn chat with 8 tool calls reported ~21 messages for 4 real
 * ones, sitting directly beside real dollar figures where a wrong count reads as
 * a data-integrity failure rather than a label bug.
 *
 * The predicate is an ALLOW-list, not a `role !== 'tool'` deny-list: any future
 * internal role added to `messages` must be excluded by DEFAULT instead of
 * silently re-inflating the figure.
 *
 * PLAIN module with ZERO imports (the lib/registry-view.ts precedent) so a
 * node-env Vitest suite can exercise it without pulling in React, Next, or the
 * Supabase client that the stats RSC itself imports.
 */

/** The only two fields this counter reads off a `messages` row. */
export interface ConversationCountRow {
  chat_id: string | null | undefined;
  role: string | null | undefined;
}

/** Roles that represent a real conversation turn a user would count. */
const CONVERSATION_ROLES = new Set(["user", "assistant"]);

/**
 * Count conversation turns per chat.
 *
 * Every chat that appears in `rows` is present in the returned map — a chat with
 * only internal rows maps to 0 rather than being absent, so the "N messages"
 * label reads "0 messages" and never renders blank.
 */
export function countConversationMessages(
  rows: readonly ConversationCountRow[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const chatId = row.chat_id;
    if (typeof chatId !== "string" || chatId.length === 0) continue;
    const current = counts.get(chatId) ?? 0;
    const isTurn = typeof row.role === "string" && CONVERSATION_ROLES.has(row.role);
    counts.set(chatId, current + (isTurn ? 1 : 0));
  }
  return counts;
}

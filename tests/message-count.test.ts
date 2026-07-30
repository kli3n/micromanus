import { describe, expect, it } from "vitest";
// RED (03-10 Task 1 / WR-06): unresolved until lib/stats/message-count.ts exists.
import { countConversationMessages } from "@/lib/stats/message-count";

/**
 * WR-06 — the per-chat "N messages" figure on /app/stats.
 *
 * Phase 3 made `role='tool'` rows numerous: one insert plus one update per tool
 * call, plus the run-meter carrier, the plan card and the artifact carrier. The
 * pre-fix inline loop counted EVERY `messages` row, so a 2-turn research chat
 * with 8 tool calls reported ~21 messages for 4 real ones — sitting beside real
 * money figures, where it reads as a data-integrity problem.
 *
 * The predicate is an ALLOW-list (`user` | `assistant`), not a `role !== 'tool'`
 * deny-list, so any future internal role added to `messages` is excluded by
 * default instead of silently re-inflating the figure.
 */

/** The 21-row shape a real 2-turn / 8-tool-call chat writes. */
function twoTurnChatWithEightToolCalls(chatId: string) {
  const rows: { chat_id: string; role: string }[] = [];
  // Turn 1 + turn 2: the only rows a human would call "messages".
  rows.push({ chat_id: chatId, role: "user" });
  rows.push({ chat_id: chatId, role: "assistant" });
  rows.push({ chat_id: chatId, role: "user" });
  rows.push({ chat_id: chatId, role: "assistant" });
  // 8 tool calls: one insert + one status update each = 16 tool rows.
  for (let i = 0; i < 16; i += 1) rows.push({ chat_id: chatId, role: "tool" });
  // The run-meter carrier — also a tool row (17 total).
  rows.push({ chat_id: chatId, role: "tool" });
  return rows;
}

describe("countConversationMessages (WR-06 conversation-turn counter)", () => {
  it("counts 4 for a chat of 2 user + 2 assistant + 17 tool rows (not 21)", () => {
    const rows = twoTurnChatWithEightToolCalls("chat-a");
    expect(rows).toHaveLength(21); // fixture sanity: the pre-fix loop said 21
    const counts = countConversationMessages(rows);
    expect(counts.get("chat-a")).toBe(4);
  });

  it("buckets rows per chat_id with no cross-contamination across three chats", () => {
    const rows = [
      { chat_id: "c1", role: "user" },
      { chat_id: "c2", role: "user" },
      { chat_id: "c2", role: "assistant" },
      { chat_id: "c1", role: "tool" },
      { chat_id: "c3", role: "user" },
      { chat_id: "c3", role: "assistant" },
      { chat_id: "c3", role: "user" },
      { chat_id: "c2", role: "tool" },
    ];
    const counts = countConversationMessages(rows);
    expect(counts.get("c1")).toBe(1);
    expect(counts.get("c2")).toBe(2);
    expect(counts.get("c3")).toBe(3);
    expect(counts.size).toBe(3);
  });

  it("keeps a tool-rows-only chat in the map with the value 0 (label reads '0 messages', never blank)", () => {
    const counts = countConversationMessages([
      { chat_id: "quiet", role: "tool" },
      { chat_id: "quiet", role: "tool" },
    ]);
    expect(counts.has("quiet")).toBe(true);
    expect(counts.get("quiet")).toBe(0);
  });

  it("does not count an unrecognised future role such as 'system' — the predicate is an allow-list", () => {
    const counts = countConversationMessages([
      { chat_id: "c", role: "user" },
      { chat_id: "c", role: "system" },
      { chat_id: "c", role: "developer" },
      { chat_id: "c", role: "assistant" },
    ]);
    expect(counts.get("c")).toBe(2);
  });
});

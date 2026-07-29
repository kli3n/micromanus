import { describe, expect, it } from "vitest";
import { filterProviderHistory } from "@/app/api/agent/run/route";

/**
 * tests/history-filter.test.ts — the D-57/D-59 provider-history hygiene seam.
 *
 * Turn 2 of a chat that used tools must not replay role='tool' rows (JSON
 * content, no tool_call_id — strict providers 400) nor empty-content assistant
 * rows (a run killed between the assistant insert and the terminal write —
 * Anthropic rejects empty text blocks). This is the SAME function
 * tests/anthropic-model.test.ts composes for breakpoint-position assertions.
 */
describe("filterProviderHistory (D-57 tool rows / D-59 empty rows)", () => {
  it("drops role='tool' rows (D-57 / E1)", () => {
    const filtered = filterProviderHistory([
      { role: "user", content: "question" },
      { role: "tool", content: '{"tool":"web_search","state":"running"}' },
      { role: "tool", content: '{"tool":"fetch_page","state":"done"}' },
      { role: "assistant", content: "answer" },
    ]);
    expect(filtered).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("drops assistant rows whose trimmed content is empty (D-59 / E1b)", () => {
    const filtered = filterProviderHistory([
      { role: "user", content: "question" },
      { role: "assistant", content: "" }, // abandoned run — terminal write never happened
      { role: "assistant", content: "   \n\t " }, // whitespace-only counts as empty
      { role: "assistant", content: "real answer" },
    ]);
    expect(filtered).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "real answer" },
    ]);
  });

  it("treats null content as empty", () => {
    const filtered = filterProviderHistory([
      { role: "user", content: "question" },
      { role: "assistant", content: null },
    ]);
    expect(filtered).toEqual([{ role: "user", content: "question" }]);
  });

  it("preserves the order and roles of surviving rows", () => {
    const filtered = filterProviderHistory([
      { role: "user", content: "first" },
      { role: "assistant", content: "a1" },
      { role: "tool", content: "{}" },
      { role: "user", content: "second" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "a2" },
    ]);
    expect(filtered).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "second" },
      { role: "assistant", content: "a2" },
    ]);
  });

  it("user rows with content always survive — even consecutive same-role runs", () => {
    // Filtering tool rows can leave two consecutive user messages; Anthropic
    // combines consecutive same-role messages, so the filter must NOT merge
    // or drop them.
    const filtered = filterProviderHistory([
      { role: "user", content: "question" },
      { role: "tool", content: "{}" },
      { role: "user", content: "Tool observations:\n..." },
    ]);
    expect(filtered).toEqual([
      { role: "user", content: "question" },
      { role: "user", content: "Tool observations:\n..." },
    ]);
  });

  it("returns [] for an empty rows array", () => {
    expect(filterProviderHistory([])).toEqual([]);
  });
});

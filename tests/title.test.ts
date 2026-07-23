import { describe, expect, it } from "vitest";
// RED (Task 1): this import is unresolved until Task 2 creates the route module
// exporting the pure `deriveChatTitle` seam. That is the intended failing state.
import { deriveChatTitle } from "@/app/api/agent/run/route";

describe("deriveChatTitle (CHAT-02 — truncation title, NO LLM call)", () => {
  it("returns a short first message unchanged and trimmed", () => {
    expect(deriveChatTitle("  Hello world  ")).toBe("Hello world");
  });

  it("caps a long first message to <= 60 chars with a trailing ellipsis", () => {
    const long = "a".repeat(200);
    const title = deriveChatTitle(long);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("normalizes newlines and runs of whitespace to single spaces (one line)", () => {
    expect(deriveChatTitle("first\n\nsecond   third")).toBe("first second third");
    expect(deriveChatTitle("a\tb")).toBe("a b");
    expect(deriveChatTitle("x\ny").includes("\n")).toBe(false);
  });

  it("falls back to a stable non-empty title for empty / whitespace-only input", () => {
    expect(deriveChatTitle("")).toBe("New chat");
    expect(deriveChatTitle("   \n\t ")).toBe("New chat");
  });

  it("is pure/synchronous — returns a string, performs no async/network work", () => {
    const out = deriveChatTitle("what is the capital of France?");
    expect(typeof out).toBe("string");
    // A pure truncation must never return a thenable (no model call).
    expect((out as unknown as { then?: unknown }).then).toBeUndefined();
  });
});

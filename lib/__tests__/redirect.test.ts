import { describe, expect, it } from "vitest";
import { safeNext } from "../redirect";

describe("safeNext (open-redirect guard)", () => {
  it("collapses off-site / malformed targets to /", () => {
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("http://evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
    expect(safeNext("evil.com")).toBe("/");
    expect(safeNext("/\\evil.com")).toBe("/");
  });

  it("passes same-site relative paths through unchanged", () => {
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/stats")).toBe("/stats");
    expect(safeNext("/chats/123")).toBe("/chats/123");
  });
});

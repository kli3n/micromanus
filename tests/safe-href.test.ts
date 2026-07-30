import { describe, expect, it } from "vitest";
// RED (03-10 Task 3 / WR-08): unresolved until lib/net/safe-href.ts exists.
import { isSafeHref } from "@/lib/net/safe-href";

/**
 * WR-08 — the RENDER-boundary scheme allow-list shared by the chat Sources list
 * and the PDF bibliography.
 *
 * The urls in a numbered Sources row come off a PERSISTED `role='tool'` row, which
 * this phase treats as untrusted everywhere else (parseArtifactCarrier, T-3-60).
 * Before this predicate, only React's built-in URL heuristic stood between a
 * persisted `javascript:` value and a clickable anchor.
 *
 * The three standard ways a scheme check is bypassed — leading whitespace, scheme
 * casing, and protocol-relative urls — each get a named test (T-03-10-02).
 *
 * NOTE: this is deliberately NOT lib/net/safe-url.ts. That module is the SSRF
 * network-target gate and additionally blocks private/loopback/CGNAT space, which
 * is correct for something the server will FETCH and wrong for something the user
 * merely CLICKS.
 */

describe("isSafeHref (WR-08 render-boundary scheme allow-list)", () => {
  it("accepts http and https urls", () => {
    expect(isSafeHref("http://example.com/a")).toBe(true);
    expect(isSafeHref("https://example.com/a")).toBe(true);
  });

  it("rejects javascript:, data:, vbscript:, file: and ftp: urls", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
    expect(isSafeHref("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeHref("file:///etc/passwd")).toBe(false);
    expect(isSafeHref("ftp://x.io/")).toBe(false);
  });

  it("does not let leading or trailing whitespace smuggle a scheme past it", () => {
    expect(isSafeHref("  javascript:alert(1)")).toBe(false);
    expect(isSafeHref("\t\njavascript:alert(1)")).toBe(false);
    expect(isSafeHref(" https://example.com ")).toBe(true);
  });

  it("does not let scheme casing smuggle a scheme past it", () => {
    expect(isSafeHref("JavaScript:alert(1)")).toBe(false);
    expect(isSafeHref("JAVASCRIPT:alert(1)")).toBe(false);
    expect(isSafeHref("HTTPS://example.com")).toBe(true);
    expect(isSafeHref("HtTp://example.com")).toBe(true);
  });

  it("rejects a protocol-relative url — it carries no explicit http(s) scheme", () => {
    expect(isSafeHref("//evil.example/x")).toBe(false);
    expect(isSafeHref("\\\\evil.example\\x")).toBe(false);
  });

  it("rejects the empty string and a bare path", () => {
    expect(isSafeHref("")).toBe(false);
    expect(isSafeHref("   ")).toBe(false);
    expect(isSafeHref("/relative")).toBe(false);
    expect(isSafeHref("example.com/a")).toBe(false);
  });
});

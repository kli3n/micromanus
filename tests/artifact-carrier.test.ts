import { describe, expect, it } from "vitest";
import { parseArtifactCarrier } from "@/components/chat/ArtifactCard";

/**
 * parseArtifactCarrier (03-06, T-3-60) — defensive read-validation of
 * persisted {kind:'artifact'} carrier rows. Rows from any deploy vintage are
 * untrusted: unknown shapes must return null (render NOTHING — the D-52
 * forward-compat idiom), never throw, never partially parse.
 */
describe("parseArtifactCarrier", () => {
  const valid = {
    id: "artifact-11111111-1111-1111-1111-111111111111",
    kind: "artifact",
    state: "ready",
    artifactId: "11111111-1111-1111-1111-111111111111",
    title: "Solid-state battery commercialization",
  };

  it("accepts all three known states", () => {
    for (const state of ["pending", "ready", "degraded"] as const) {
      const parsed = parseArtifactCarrier({ ...valid, state });
      expect(parsed).not.toBeNull();
      expect(parsed?.state).toBe(state);
      expect(parsed?.artifactId).toBe(valid.artifactId);
      expect(parsed?.title).toBe(valid.title);
    }
  });

  it("rejects unknown states (forward-compat: a future state renders nothing)", () => {
    expect(parseArtifactCarrier({ ...valid, state: "rendering" })).toBeNull();
    expect(parseArtifactCarrier({ ...valid, state: "" })).toBeNull();
    expect(parseArtifactCarrier({ ...valid, state: 1 })).toBeNull();
    expect(parseArtifactCarrier({ ...valid, state: undefined })).toBeNull();
  });

  it("rejects non-artifact kinds and missing kind", () => {
    expect(parseArtifactCarrier({ ...valid, kind: "plan" })).toBeNull();
    expect(parseArtifactCarrier({ ...valid, kind: undefined })).toBeNull();
  });

  it("rejects a missing / empty / non-string artifactId", () => {
    expect(parseArtifactCarrier({ ...valid, artifactId: undefined })).toBeNull();
    expect(parseArtifactCarrier({ ...valid, artifactId: "" })).toBeNull();
    expect(parseArtifactCarrier({ ...valid, artifactId: 42 })).toBeNull();
    expect(parseArtifactCarrier({ ...valid, artifactId: null })).toBeNull();
  });

  it("rejects non-object payloads without throwing", () => {
    expect(parseArtifactCarrier(null)).toBeNull();
    expect(parseArtifactCarrier(undefined)).toBeNull();
    expect(parseArtifactCarrier("artifact")).toBeNull();
    expect(parseArtifactCarrier(7)).toBeNull();
  });

  it("falls back to a generic title when the carrier title is missing or empty", () => {
    expect(parseArtifactCarrier({ ...valid, title: "" })?.title).toBe(
      "Research report",
    );
    expect(parseArtifactCarrier({ ...valid, title: undefined })?.title).toBe(
      "Research report",
    );
    expect(parseArtifactCarrier({ ...valid, title: 9 })?.title).toBe(
      "Research report",
    );
  });

  it("passes through a non-empty markdown string only (forward-compat field)", () => {
    expect(parseArtifactCarrier(valid)?.markdown).toBeUndefined();
    expect(parseArtifactCarrier({ ...valid, markdown: "" })?.markdown).toBeUndefined();
    expect(parseArtifactCarrier({ ...valid, markdown: 3 })?.markdown).toBeUndefined();
    expect(
      parseArtifactCarrier({ ...valid, markdown: "# Report" })?.markdown,
    ).toBe("# Report");
  });
});

import { describe, expect, it } from "vitest";

import { workDetailRoute } from "./workDetailNavigation";

describe("workDetailRoute", () => {
  it("keeps the canonical identity and exact remote edition for a known work", () => {
    expect(workDetailRoute({
      kind: "known",
      canonicalCode: "SAMPLE-ORIGIN",
      source: { sourceId: 7, remoteCode: "SAMPLE-TRANSLATION" },
    })).toBe("/SAMPLE-ORIGIN?view=remote&source=7&remoteCode=SAMPLE-TRANSLATION");
  });

  it("opens an unpersisted remote work by its source-local code", () => {
    expect(workDetailRoute({
      kind: "remote-only",
      sourceId: 4,
      remoteCode: "REMOTE-SAMPLE",
    })).toBe("/REMOTE-SAMPLE?source=4");
  });

  it("keeps the forked source selected when entering tracked detail", () => {
    expect(workDetailRoute({
      kind: "known",
      canonicalCode: "SAMPLE-ORIGIN",
      view: "tracked",
      trackedSourceId: 7,
    })).toBe("/SAMPLE-ORIGIN?view=tracked&trackedSource=7");
  });

  it("rejects an incomplete remote intent", () => {
    expect(workDetailRoute({
      kind: "known",
      canonicalCode: "SAMPLE-ORIGIN",
      source: { sourceId: 0, remoteCode: "SAMPLE-TRANSLATION" },
    })).toBeNull();
  });
});

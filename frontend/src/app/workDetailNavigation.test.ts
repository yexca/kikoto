import { describe, expect, it } from "vitest";

import { workDetailCodeFromLocation, workDetailRoute } from "./workDetailNavigation";

describe("workDetailRoute", () => {
  it("keeps the canonical identity and exact remote edition for a known work", () => {
    expect(
      workDetailRoute({
        kind: "known",
        canonicalCode: "SAMPLE-ORIGIN",
        source: { sourceId: 7, remoteCode: "SAMPLE-TRANSLATION" },
      }),
    ).toBe("/SAMPLE-ORIGIN?view=remote&source=7&remoteCode=SAMPLE-TRANSLATION");
  });

  it("opens an unpersisted remote work by its source-local code", () => {
    expect(
      workDetailRoute({
        kind: "remote-only",
        sourceId: 4,
        remoteCode: "REMOTE-SAMPLE",
      }),
    ).toBe("/REMOTE-SAMPLE?source=4");
  });

  it("keeps the forked source selected when entering tracked detail", () => {
    expect(
      workDetailRoute({
        kind: "known",
        canonicalCode: "SAMPLE-ORIGIN",
        view: "tracked",
        trackedSourceId: 7,
      }),
    ).toBe("/SAMPLE-ORIGIN?view=tracked&trackedSource=7");
  });

  it("rejects an incomplete remote intent", () => {
    expect(
      workDetailRoute({
        kind: "known",
        canonicalCode: "SAMPLE-ORIGIN",
        source: { sourceId: 0, remoteCode: "SAMPLE-TRANSLATION" },
      }),
    ).toBeNull();
  });
});

describe("workDetailCodeFromLocation", () => {
  it("recognizes a canonical work link, including its edition query", () => {
    expect(workDetailCodeFromLocation("/rj00000001", "")).toBe("RJ00000001");
    expect(workDetailCodeFromLocation("/RJ00000001/", "?view=remote&source=7&remoteCode=SAMPLE")).toBe("RJ00000001");
  });

  it("recognizes a remote-only work link by its source-local code", () => {
    const route = workDetailRoute({ kind: "remote-only", sourceId: 4, remoteCode: "REMOTE SAMPLE" }) ?? "";
    const url = new URL(route, "https://kikoto.invalid");
    expect(workDetailCodeFromLocation(url.pathname, url.search)).toBe("REMOTE SAMPLE");
  });

  it("leaves list locations to the Library list", () => {
    expect(workDetailCodeFromLocation("/", "?q=sample")).toBeNull();
    expect(workDetailCodeFromLocation("/sample-source", "")).toBeNull();
    expect(workDetailCodeFromLocation("/REMOTE-SAMPLE", "?source=0")).toBeNull();
    expect(workDetailCodeFromLocation("/library/source/sample-source", "?source=4")).toBeNull();
  });
});

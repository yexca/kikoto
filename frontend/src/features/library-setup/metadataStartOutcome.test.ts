import { describe, expect, it } from "vitest";

import { metadataStartOutcome, metadataStartSettled } from "./metadataStartOutcome";

describe("metadataStartOutcome", () => {
  it("reports a queued sync only when the server has a run for it", () => {
    expect(metadataStartOutcome("queued")).toBe("queued");
    expect(metadataStartOutcome("running")).toBe("queued");
  });

  it("does not report a sync when the server only answered with its current state", () => {
    expect(metadataStartOutcome("waiting")).toBe("waiting");
    expect(metadataStartOutcome("hidden")).toBe("not_started");
    expect(metadataStartOutcome("succeeded")).toBe("finished");
    expect(metadataStartOutcome("partial")).toBe("attention");
    expect(metadataStartOutcome("failed")).toBe("attention");
  });

  it("keeps the start action available until a sync is under way or done", () => {
    expect(metadataStartSettled(null)).toBe(false);
    expect(metadataStartSettled("waiting")).toBe(false);
    expect(metadataStartSettled("not_started")).toBe(false);
    expect(metadataStartSettled("attention")).toBe(false);
    expect(metadataStartSettled("queued")).toBe(true);
    expect(metadataStartSettled("finished")).toBe(true);
  });
});

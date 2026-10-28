import { describe, expect, it } from "vitest";

import type { AvailabilityWatchTarget } from "@/lib/api";
import { syntheticWorkCode } from "@/test-support/workCode";
import {
  cleanableWatchTargets,
  foldedTargetSlots,
  groupWatchTargets,
  parseWatchCodes,
  sortWatchTargets,
  watchTargetAllows,
  watchTargetGroup,
  watchTargetMatches,
} from "./availabilityWatchModel";

function target(index: number, patch: Partial<AvailabilityWatchTarget> = {}): AvailabilityWatchTarget {
  return {
    id: index,
    workCode: syntheticWorkCode("RJ", index),
    title: "",
    coverUrl: "",
    state: "monitoring",
    nextCheckAt: "",
    lastCheckedAt: "",
    lastStatus: "",
    lastError: "",
    availableSourceId: null,
    availableCode: "",
    trackRunId: null,
    fetchRunId: null,
    trackRunStatus: "",
    fetchRunStatus: "",
    inLibrary: false,
    addedAt: "2026-10-01 00:00:00",
    releaseDate: "",
    family: [],
    ...patch,
  };
}

const available = (index: number, patch: Partial<AvailabilityWatchTarget> = {}) =>
  target(index, { state: "ready", availableSourceId: 1, availableCode: syntheticWorkCode("RJ", index), ...patch });

describe("watchTargetGroup", () => {
  it("places each target in one group by availability, its runs, and the library", () => {
    expect(watchTargetGroup(available(1))).toBe("available");
    expect(watchTargetGroup(target(2))).toBe("waiting");
    expect(watchTargetGroup(target(3, { state: "error", lastError: "Availability check failed" }))).toBe("failed");
    expect(watchTargetGroup(available(4, { inLibrary: true }))).toBe("inLibrary");
    expect(watchTargetGroup(target(5, { inLibrary: true }))).toBe("inLibrary");
    for (const status of ["queued", "running", "failed", "partial"]) {
      expect(watchTargetGroup(available(6, { fetchRunId: 60, fetchRunStatus: status }))).toBe("inProgress");
    }
  });

  it("keeps a running Fetch in progress even when files have arrived, then moves it to the library", () => {
    expect(watchTargetGroup(available(1, { fetchRunId: 10, fetchRunStatus: "running", inLibrary: true }))).toBe(
      "inProgress",
    );
    expect(watchTargetGroup(available(1, { fetchRunId: 10, fetchRunStatus: "succeeded", inLibrary: true }))).toBe(
      "inLibrary",
    );
  });

  it("groups the pool top to bottom and leaves removed targets out", () => {
    const groups = groupWatchTargets([
      available(1),
      target(2),
      target(3, { state: "disabled" }),
      available(4, { trackRunId: 40, trackRunStatus: "queued" }),
    ]);
    expect(Object.keys(groups)).toEqual(["available", "inProgress", "waiting", "failed", "inLibrary"]);
    expect(groups.available.map((item) => item.id)).toEqual([1]);
    expect(groups.inProgress.map((item) => item.id)).toEqual([4]);
    expect(groups.waiting.map((item) => item.id)).toEqual([2]);
  });
});

describe("watchTargetAllows", () => {
  it("offers Track and Fetch on available works the library lacks, again after a failure but not while running", () => {
    expect(watchTargetAllows(available(1), "fetch")).toBe(true);
    expect(watchTargetAllows(available(1, { inLibrary: true }), "fetch")).toBe(false);
    expect(watchTargetAllows(target(2), "fetch")).toBe(false);
    expect(watchTargetAllows(available(3, { fetchRunId: 30, fetchRunStatus: "running" }), "fetch")).toBe(false);
    expect(watchTargetAllows(available(3, { fetchRunId: 30, fetchRunStatus: "running" }), "track")).toBe(true);
    expect(watchTargetAllows(available(4, { fetchRunId: 40, fetchRunStatus: "failed" }), "fetch")).toBe(true);
  });

  it("checks only waiting and failed targets the library lacks, and removes any", () => {
    expect(watchTargetAllows(target(1), "check")).toBe(true);
    expect(watchTargetAllows(target(2, { state: "error" }), "check")).toBe(true);
    expect(watchTargetAllows(available(3), "check")).toBe(false);
    expect(watchTargetAllows(target(4, { inLibrary: true }), "check")).toBe(false);
    expect(watchTargetAllows(available(3), "remove")).toBe(true);
  });
});

describe("cleanableWatchTargets", () => {
  it("counts works in the library and works whose Track or Fetch is done, each once", () => {
    const { inLibrary, done } = cleanableWatchTargets([
      available(1, { inLibrary: true, fetchRunId: 10, fetchRunStatus: "succeeded" }),
      available(2, { trackRunId: 20, trackRunStatus: "succeeded" }),
      available(3, { trackRunId: 30, trackRunStatus: "succeeded", fetchRunId: 31, fetchRunStatus: "running" }),
      available(4, { fetchRunId: 40, fetchRunStatus: "failed" }),
      target(5),
    ]);
    expect(inLibrary.map((item) => item.id)).toEqual([1]);
    expect(done.map((item) => item.id)).toEqual([2]);
  });
});

describe("parseWatchCodes", () => {
  it("extracts codes from DLsite URLs and mixed text and sorts them into new, watched, and not a code", () => {
    const watched = syntheticWorkCode("RJ", 1);
    const fresh = syntheticWorkCode("RJ", 2);
    const fromUrl = syntheticWorkCode("RJ", 3);
    const parsed = parseWatchCodes(
      `${watched}, ${fresh.toLowerCase()} https://www.dlsite.example/maniax/work/=/product_id/${fromUrl}.html hello ${fresh} KT00000001`,
      new Set([watched]),
    );
    expect(parsed).toEqual({ codes: [fresh, fromUrl], watched: [watched], invalid: ["hello", "KT00000001"] });
  });
});

describe("sortWatchTargets and watchTargetMatches", () => {
  it("orders newest first by added time or by release date, unknown release dates last", () => {
    const pool = [
      target(1, { addedAt: "2026-10-01 00:00:00", releaseDate: "2026-09-01" }),
      target(2, { addedAt: "2026-10-03 00:00:00", releaseDate: "" }),
      target(3, { addedAt: "2026-10-02 00:00:00", releaseDate: "2026-10-20" }),
    ];
    expect(sortWatchTargets(pool, "added").map((item) => item.id)).toEqual([2, 3, 1]);
    expect(sortWatchTargets(pool, "release").map((item) => item.id)).toEqual([3, 1, 2]);
  });

  it("finds a target by code, edition, or title", () => {
    const edition = syntheticWorkCode("RJ", 88);
    const item = available(1, { title: "Example Title", availableCode: edition });
    expect(watchTargetMatches(item, "example")).toBe(true);
    expect(watchTargetMatches(item, edition.toLowerCase())).toBe(true);
    expect(watchTargetMatches(item, "nothing")).toBe(false);
  });
});

describe("foldedTargetSlots", () => {
  it("folds to whole rows", () => {
    expect(foldedTargetSlots(1)).toBe(6);
    expect(foldedTargetSlots(2)).toBe(6);
    expect(foldedTargetSlots(3)).toBe(6);
    expect(foldedTargetSlots(4)).toBe(8);
  });
});

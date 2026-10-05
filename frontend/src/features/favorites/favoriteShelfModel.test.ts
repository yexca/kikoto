import { describe, expect, it } from "vitest";

import type { FavoriteList, Work } from "@/lib/api";
import {
  favoriteResumeFraction,
  favoriteResumeRemainingSeconds,
  favoriteShelfCovers,
  favoriteShelfKind,
  favoriteShelfProgress,
  favoriteStatusFilterOptions,
} from "./favoriteShelfModel";

const markedList: FavoriteList = { id: 1, name: "", description: "", sortOrder: -1, kind: "marked" };

function progress(positionSeconds: number, durationSeconds: number | null): Work["progress"] {
  return {
    workId: 1,
    mediaWorkId: 1,
    mediaItemId: 1,
    fileSourceId: null,
    locationId: null,
    locationType: "local",
    title: "Track 01",
    positionSeconds,
    durationSeconds,
    lastPlayedAt: "2026-01-01T00:00:00Z",
    completed: false,
  };
}

describe("favorite status filters", () => {
  it("keeps every quick mark and shows Unmarked only while it holds works or is selected", () => {
    const counts = { want_to_listen: 2, listening: 1, finished: 3 };
    expect(favoriteStatusFilterOptions(counts, 6, "all").map((option) => option.value)).toEqual([
      "all",
      "want_to_listen",
      "listening",
      "finished",
      "relisten",
      "paused",
    ]);
    expect(favoriteStatusFilterOptions(counts, 6, "none")).toContainEqual({ value: "none", count: 0 });
    expect(favoriteStatusFilterOptions({ ...counts, none: 4 }, 10, "all")).toContainEqual({ value: "none", count: 4 });
  });
});

describe("favorite shelf progress", () => {
  it("counts finished and relisten works as listened", () => {
    expect(favoriteShelfProgress({ finished: 5, relisten: 1, listening: 3, want_to_listen: 7, none: 4 })).toEqual({
      total: 20,
      listened: 6,
      listening: 3,
      queued: 7,
      percent: 30,
    });
  });

  it("reports an empty shelf without dividing by zero", () => {
    expect(favoriteShelfProgress({}).percent).toBe(0);
  });
});

describe("favorite shelf artwork", () => {
  it("takes distinct covers in result order and skips missing ones", () => {
    const works = ["/a.jpg", "", "/b.jpg", "/a.jpg", "/c.jpg", "/d.jpg", "/e.jpg"].map((coverUrl) => ({ coverUrl }));
    expect(favoriteShelfCovers(works)).toEqual(["/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg"]);
  });
});

describe("favorite shelf kind", () => {
  it("separates the whole collection, the system list, and user lists", () => {
    expect(favoriteShelfKind("all", markedList)).toBe("all");
    expect(favoriteShelfKind(1, markedList)).toBe("marked");
    expect(favoriteShelfKind(2, markedList)).toBe("list");
    expect(favoriteShelfKind(1, null)).toBe("list");
  });
});

describe("favorite resume point", () => {
  it("measures the saved track position and tolerates unknown or overrun lengths", () => {
    expect(favoriteResumeRemainingSeconds(progress(90, 600))).toBe(510);
    expect(favoriteResumeFraction(progress(150, 600))).toBe(0.25);
    expect(favoriteResumeRemainingSeconds(progress(700, 600))).toBe(0);
    expect(favoriteResumeFraction(progress(700, 600))).toBe(1);
    expect(favoriteResumeRemainingSeconds(progress(90, null))).toBeNull();
    expect(favoriteResumeFraction(progress(90, 0))).toBe(0);
  });
});

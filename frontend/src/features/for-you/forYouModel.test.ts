import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import type { ForYouItem, Work } from "@/lib/api";
import { syntheticWorkCode } from "@/test-support/workCode";

import {
  advanceForYouDrawRevision,
  emptyForYouColumns,
  forYouColumnsFromSnapshot,
  forYouReasonText,
  forYouSnapshotFromColumns,
  initialForYouDrawRevision,
  isCurrentForYouDrawRevision,
  otherColumnWorkIds,
  parseForYouSnapshot,
  patchForYouColumns,
} from "./forYouModel";

const t = i18n.getFixedT("en") as TFunction;
const rating = (value: number) => value.toFixed(1);

function item(id: number): ForYouItem {
  return {
    work: { id, primaryCode: syntheticWorkCode("RJ", id) } as Work,
    score: 50,
    reason: { kind: "unexplored" },
  };
}

describe("For you model", () => {
  it("invalidates a late column draw after a newer full draw", () => {
    const initial = initialForYouDrawRevision();
    const column = advanceForYouDrawRevision(initial, ["maybe_like"]);
    const full = advanceForYouDrawRevision(column, ["maybe_like", "try_new", "listen_again"]);

    expect(isCurrentForYouDrawRevision(column, full, ["maybe_like"])).toBe(false);
    expect(isCurrentForYouDrawRevision(full, full, ["maybe_like", "try_new", "listen_again"])).toBe(true);
  });

  it("keeps independent column draws current", () => {
    const initial = initialForYouDrawRevision();
    const maybeLike = advanceForYouDrawRevision(initial, ["maybe_like"]);
    const tryNew = advanceForYouDrawRevision(maybeLike, ["try_new"]);

    expect(isCurrentForYouDrawRevision(maybeLike, tryNew, ["maybe_like"])).toBe(true);
    expect(isCurrentForYouDrawRevision(tryNew, tryNew, ["try_new"])).toBe(true);
  });

  it("states why a work was drawn with the facts it carries", () => {
    expect(forYouReasonText({ kind: "liked_circle", name: "Example Circle" }, t, rating)).toBe(
      "A circle you like: Example Circle",
    );
    expect(forYouReasonText({ kind: "rare_tag", name: "Example Tag" }, t, rating)).toBe(
      "A tag you rarely hear: Example Tag",
    );
    expect(forYouReasonText({ kind: "since_played", days: 120, rating: 5 }, t, rating)).toBe(
      "4 months since last played, rated 5",
    );
    expect(forYouReasonText({ kind: "since_played", days: 400, favorite: true }, t, rating)).toBe(
      "1 year since last played, a favorite",
    );
    expect(forYouReasonText({ kind: "unfinished", days: 20 }, t, rating)).toBe("Left unfinished 20 days ago");
    expect(forYouReasonText({ kind: "popular", dlsiteRating: 4.62 }, t, rating)).toBe("Popular on DLsite, rated 4.6");
  });

  it("keeps only a settled draw and restores it as shown", () => {
    const columns = emptyForYouColumns();
    expect(forYouSnapshotFromColumns(columns, "balanced", "for-you-v1")).toBeNull();

    for (const column of ["maybe_like", "try_new", "listen_again"] as const) columns[column].drawing = false;
    columns.maybe_like.items = [item(1)];
    columns.try_new = { items: [item(2)], coldStart: false, drawing: false, failed: true };
    columns.listen_again.coldStart = true;
    const snapshot = forYouSnapshotFromColumns(columns, "safe", "for-you-v1");
    expect(snapshot).not.toBeNull();
    const restored = forYouColumnsFromSnapshot(parseForYouSnapshot(JSON.parse(JSON.stringify(snapshot)))!);
    expect(restored.maybe_like.items.map((entry) => entry.work.id)).toEqual([1]);
    // A column whose draw again failed still shows its earlier works, which is what is kept.
    expect(restored.try_new).toMatchObject({ drawing: false, failed: false });
    expect(restored.listen_again).toMatchObject({ items: [], coldStart: true });

    columns.try_new.items = [];
    expect(forYouSnapshotFromColumns(columns, "safe", "for-you-v1")).toBeNull();
  });

  it("rejects a stored value this version did not write", () => {
    expect(parseForYouSnapshot(null)).toBeNull();
    expect(parseForYouSnapshot({ temperature: "warm", algorithmVersion: "", columns: {} })).toBeNull();
    const columns = { items: [{ work: { id: "1" }, score: 1, reason: { kind: "want" } }], coldStart: false };
    expect(
      parseForYouSnapshot({
        temperature: "balanced",
        algorithmVersion: "for-you-v1",
        columns: { maybe_like: columns, try_new: columns, listen_again: columns },
      }),
    ).toBeNull();
  });

  it("patches every card of a work and leaves columns without it unchanged", () => {
    const columns = emptyForYouColumns();
    columns.maybe_like.items = [item(1)];
    expect(patchForYouColumns(columns, 9, { favorite: true })).toBe(columns);
    const patched = patchForYouColumns(columns, 1, { favorite: true });
    expect(patched.maybe_like.items[0].work.favorite).toBe(true);
    expect(patched.try_new).toBe(columns.try_new);
  });

  it("leaves out only what the other columns show when one column draws again", () => {
    const columns = emptyForYouColumns();
    columns.maybe_like.items = [item(1), item(2)];
    columns.try_new.items = [item(3)];
    columns.listen_again.items = [item(4)];
    expect(otherColumnWorkIds(columns, "try_new")).toEqual([1, 2, 4]);
  });
});

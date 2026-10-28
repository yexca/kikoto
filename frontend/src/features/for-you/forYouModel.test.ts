import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import type { ForYouItem, Work } from "@/lib/api";

import { emptyForYouColumns, forYouReasonText, otherColumnWorkIds } from "./forYouModel";

const t = i18n.getFixedT("en") as TFunction;
const rating = (value: number) => value.toFixed(1);

function item(id: number): ForYouItem {
  return { work: { id } as Work, score: 50, reason: { kind: "unexplored" } };
}

describe("For you model", () => {
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

  it("leaves out only what the other columns show when one column draws again", () => {
    const columns = emptyForYouColumns();
    columns.maybe_like.items = [item(1), item(2)];
    columns.try_new.items = [item(3)];
    columns.listen_again.items = [item(4)];
    expect(otherColumnWorkIds(columns, "try_new")).toEqual([1, 2, 4]);
  });
});

import { describe, expect, it } from "vitest";

import { favoriteListCreateName, filterFavoriteListsByName } from "./favoriteListPickerModel";

const lists = [{ name: "Night Rain" }, { name: "Commute" }, { name: "rain sounds" }];

describe("favorite list picker search", () => {
  it("keeps list order and matches any part of a name regardless of case and spaces", () => {
    expect(filterFavoriteListsByName(lists, "  RAIN ")).toEqual([{ name: "Night Rain" }, { name: "rain sounds" }]);
    expect(filterFavoriteListsByName(lists, " ")).toEqual(lists);
  });

  it("offers to create the trimmed query unless a list already has that name", () => {
    expect(favoriteListCreateName(lists, "  Sleep  ")).toBe("Sleep");
    expect(favoriteListCreateName(lists, "commute ")).toBeNull();
    expect(favoriteListCreateName(lists, "Rain")).toBe("Rain");
    expect(favoriteListCreateName(lists, "   ")).toBeNull();
  });
});

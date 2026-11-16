import { describe, expect, it } from "vitest";

import { favoriteListCreateName, filterFavoriteListsByName, workMemberLists } from "./favoriteListPickerModel";

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

describe("the lists a work's list button names", () => {
  it("lead with the most recent addition and leave out Marked and unselected lists", () => {
    const workLists = [
      { name: "Marked", kind: "marked", selected: true },
      { name: "Study", kind: "user", selected: true, memberOrder: 2 },
      { name: "Sleep", kind: "user", selected: false },
      { name: "Later", kind: "user", selected: true, memberOrder: 1 },
      { name: "Calm", kind: "smart", selected: true, memberOrder: 3 },
    ];
    expect(workMemberLists(workLists).map((list) => list.name)).toEqual(["Later", "Study", "Calm"]);
  });

  it("keep list order for lists without a place", () => {
    const workLists = [
      { name: "Study", kind: "user", selected: true },
      { name: "Later", kind: "user", selected: true, memberOrder: 1 },
      { name: "Calm", kind: "smart", selected: true },
    ];
    expect(workMemberLists(workLists).map((list) => list.name)).toEqual(["Later", "Study", "Calm"]);
  });
});

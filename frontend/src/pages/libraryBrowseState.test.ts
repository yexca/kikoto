import { describe, expect, it } from "vitest";

import {
  defaultLibraryBrowseState,
  libraryBrowseSearch,
  libraryBrowseStateFromSearch,
  libraryBrowseStateFromValue,
  withSharedLibraryQuery,
} from "./libraryBrowseState";

describe("library browse state", () => {
  it("defaults new library views to recommendation ordering", () => {
    expect(defaultLibraryBrowseState.sort).toBe("recommend");
    expect(defaultLibraryBrowseState.direction).toBe("desc");
    expect(defaultLibraryBrowseState.desktopColumns).toBe(5);
  });

  it("round-trips shareable URL fields without including scroll position", () => {
    const state = {
      ...defaultLibraryBrowseState,
      query: "tag:耳かき",
      page: 3,
      pageSize: 48,
      status: "listening" as const,
      sort: "rating" as const,
      direction: "asc" as const,
      view: "masonry" as const,
      mobileColumns: 2 as const,
      desktopColumns: 7 as const,
      scrollY: 640,
    };

    const restored = libraryBrowseStateFromSearch(libraryBrowseSearch(state), defaultLibraryBrowseState);

    expect(restored).toEqual({ ...state, scrollY: 0 });
  });

  it("uses fallback values for unsupported or unsafe persisted values", () => {
    const restored = libraryBrowseStateFromValue(
      {
        page: -2,
        pageSize: 1000,
        status: "unknown",
        sort: "unsupported",
        randomSeed: -1,
        direction: "sideways",
        view: "list",
        mobileColumns: 10,
        desktopColumns: 0,
        scrollY: -1,
      },
      defaultLibraryBrowseState,
    );

    expect(restored).toEqual(defaultLibraryBrowseState);
  });

  it("normalizes numeric URL values", () => {
    const restored = libraryBrowseStateFromSearch(
      "?page=2.8&pageSize=48&mobileColumns=3&desktopColumns=8",
      defaultLibraryBrowseState,
    );

    expect(restored.page).toBe(2);
    expect(restored.pageSize).toBe(48);
    expect(restored.mobileColumns).toBe(3);
    expect(restored.desktopColumns).toBe(8);
  });

  it("shares a changed query while retaining source-specific browse preferences", () => {
    const sourceState = {
      ...defaultLibraryBrowseState,
      query: "old query",
      page: 4,
      sort: "sales" as const,
      view: "masonry" as const,
      scrollY: 900,
    };

    expect(withSharedLibraryQuery(sourceState, "RJ01000012")).toEqual({
      ...sourceState,
      query: "RJ01000012",
      page: 1,
      scrollY: 0,
    });
  });
});

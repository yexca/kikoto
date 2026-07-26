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
    expect(defaultLibraryBrowseState.mobileColumns).toBe("auto");
    expect(defaultLibraryBrowseState.desktopColumns).toBe("auto");
  });

  it("keeps only semantic search fields in the canonical URL", () => {
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

    const restored = libraryBrowseStateFromSearch(libraryBrowseSearch(state), state);

    expect(libraryBrowseSearch(state)).toBe("?q=tag%3A%E8%80%B3%E3%81%8B%E3%81%8D&status=listening");
    expect(restored).toEqual(state);
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

  it("retains persisted columns when the canonical URL omits layout", () => {
    const restored = libraryBrowseStateFromSearch(libraryBrowseSearch(defaultLibraryBrowseState), {
      ...defaultLibraryBrowseState,
      mobileColumns: 1,
      desktopColumns: 5,
    });

    expect(restored.mobileColumns).toBe(1);
    expect(restored.desktopColumns).toBe(5);
  });

  it("continues to read legacy full-state URLs", () => {
    const restored = libraryBrowseStateFromSearch(
      "?page=4&pageSize=48&sort=sales&direction=asc&seed=99&status=finished&view=masonry&mobileColumns=2&desktopColumns=6",
      defaultLibraryBrowseState,
    );
    expect(restored).toMatchObject({
      page: 4,
      pageSize: 48,
      sort: "sales",
      direction: "asc",
      randomSeed: 99,
      status: "finished",
      view: "masonry",
      mobileColumns: 2,
      desktopColumns: 6,
    });
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

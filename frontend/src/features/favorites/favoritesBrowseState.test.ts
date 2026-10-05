import { describe, expect, it } from "vitest";

import {
  defaultFavoritesBrowseState,
  favoritesBrowseSearch,
  favoritesBrowseStateFromSearch,
  favoritesBrowseStateFromValue,
  personalTagSearch,
} from "./favoritesBrowseState";

describe("favorites browse state", () => {
  it("defaults to recently added favorites", () => {
    expect(defaultFavoritesBrowseState.sort).toBe("added");
  });

  it("keeps recoverable state outside the canonical URL", () => {
    const state = {
      ...defaultFavoritesBrowseState,
      entity: "works" as const,
      query: 'mytag:"Sleep aid"',
      status: "listening" as const,
      availability: "local" as const,
      sourceIDs: [11, 12],
      list: 42,
      page: 3,
      pageSize: 48 as const,
      sort: "sales" as const,
      direction: "asc" as const,
      randomSeed: 314159,
    };
    expect(favoritesBrowseSearch(state)).toBe("?q=mytag%3A%22Sleep+aid%22");
    expect(favoritesBrowseStateFromSearch(favoritesBrowseSearch(state), state)).toEqual(state);
    expect(favoritesBrowseStateFromValue(state)).toEqual(state);
  });

  it("normalizes persisted source selections without placing them in the canonical URL", () => {
    const restored = favoritesBrowseStateFromValue({
      ...defaultFavoritesBrowseState,
      sourceIDs: [12, "11", 12, 0, -1, "invalid"],
    });

    expect(restored.sourceIDs).toEqual([12, 11]);
    expect(favoritesBrowseSearch(restored)).toBe("");
  });

  it("continues to read legacy full-state URLs", () => {
    const restored = favoritesBrowseStateFromSearch(
      "?entity=voices&q=quiet&status=finished&availability=remote&list=42&page=3&pageSize=48&sort=sales&direction=asc&seed=314159",
    );
    expect(restored).toMatchObject({
      entity: "voices",
      query: "quiet",
      status: "finished",
      availability: "remote",
      list: 42,
      page: 3,
      pageSize: 48,
      sort: "sales",
      direction: "asc",
      randomSeed: 314159,
    });
  });

  it("normalizes invalid values", () => {
    expect(
      favoritesBrowseStateFromSearch("?entity=nope&page=-1&pageSize=96&list=bad&sort=nope&direction=sideways&seed=0"),
    ).toEqual(defaultFavoritesBrowseState);
  });

  it("quotes personal tag filters", () => {
    expect(personalTagSearch('Sleep "quiet"')).toBe('mytag:"Sleep \\"quiet\\""');
  });
});

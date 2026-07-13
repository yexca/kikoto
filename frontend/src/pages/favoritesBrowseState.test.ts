import { describe, expect, it } from "vitest";

import {
  defaultFavoritesBrowseState,
  favoritesBrowseSearch,
  favoritesBrowseStateFromSearch,
  personalTagSearch,
} from "./favoritesBrowseState";

describe("favorites browse state", () => {
  it("round trips recoverable favorites state", () => {
    const state = {
      ...defaultFavoritesBrowseState,
      entity: "works" as const,
      query: 'mytag:"Sleep aid"',
      status: "listening" as const,
      availability: "local" as const,
      list: 42,
      page: 3,
      pageSize: 48 as const,
    };
    expect(favoritesBrowseStateFromSearch(favoritesBrowseSearch(state))).toEqual(state);
  });

  it("normalizes invalid values", () => {
    expect(favoritesBrowseStateFromSearch("?entity=nope&page=-1&pageSize=96&list=bad")).toEqual(defaultFavoritesBrowseState);
  });

  it("quotes personal tag filters", () => {
    expect(personalTagSearch('Sleep "quiet"')).toBe('mytag:"Sleep \\"quiet\\""');
  });
});

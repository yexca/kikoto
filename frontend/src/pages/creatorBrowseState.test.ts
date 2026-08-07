import { describe, expect, it } from "vitest";

import { creatorBrowseSearch, creatorBrowseStateFromSearch } from "./creatorBrowseState";

const filters = ["all", "favorite", "missing"] as const;
const fallback = { query: "", filter: "all" as const, tag: "", page: 1, pageSize: 24 };

describe("creator browse state", () => {
  it("round trips list state", () => {
    const state = { query: "RJ123", filter: "favorite" as const, tag: "calm", page: 3, pageSize: 48 };
    expect(creatorBrowseStateFromSearch(creatorBrowseSearch(state), fallback, filters, [24, 48, 96])).toEqual(state);
  });

  it("normalizes unsupported values", () => {
    expect(creatorBrowseStateFromSearch("?filter=nope&page=-2&pageSize=25", fallback, filters, [24, 48, 96])).toEqual(
      fallback,
    );
  });
});

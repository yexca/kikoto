import { describe, expect, it } from "vitest";

import { paginationItems } from "./paginationModel";

describe("paginationItems", () => {
  it("includes the first, last, current, and adjacent pages", () => {
    expect(paginationItems(6, 20)).toEqual([1, "ellipsis-left", 5, 6, 7, "ellipsis-right", 20]);
  });

  it("does not add ellipses for contiguous pages", () => {
    expect(paginationItems(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("clamps invalid page values", () => {
    expect(paginationItems(30, 5)).toEqual([1, "ellipsis-left", 4, 5]);
  });
});

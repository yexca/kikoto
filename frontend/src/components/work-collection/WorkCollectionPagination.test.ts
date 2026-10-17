import { describe, expect, it } from "vitest";

import { pageJumpTarget, paginationItems, paginationSiblingsForWidth } from "./paginationModel";

describe("paginationItems", () => {
  it("includes the first, last, current, and adjacent pages", () => {
    expect(paginationItems(6, 20)).toEqual([1, "ellipsis-left", 5, 6, 7, "ellipsis-right", 20]);
  });

  it("does not add ellipses for contiguous pages", () => {
    expect(paginationItems(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("clamps invalid page values", () => {
    expect(paginationItems(30, 20)).toEqual([1, "ellipsis-left", 16, 17, 18, 19, 20]);
    expect(paginationItems(0, 20)).toEqual([1, 2, 3, 4, 5, "ellipsis-right", 20]);
  });

  it("keeps the same number of items on every page so the arrows stay in place", () => {
    for (const siblings of [1, 2, 4]) {
      const counts = new Set(Array.from({ length: 40 }, (_, index) => paginationItems(index + 1, 40, siblings).length));
      expect(counts).toEqual(new Set([2 * siblings + 5]));
    }
  });

  it("shows more pages around the current page on a wider bar", () => {
    expect(paginationItems(20, 40, 3)).toEqual([1, "ellipsis-left", 17, 18, 19, 20, 21, 22, 23, "ellipsis-right", 40]);
  });

  it("lists every page when they fit in the bar", () => {
    expect(paginationItems(5, 9, 2)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("paginationSiblingsForWidth", () => {
  it("shows one page on each side on a phone and more on wider bars", () => {
    expect(paginationSiblingsForWidth(0)).toBe(1);
    expect(paginationSiblingsForWidth(343)).toBe(1);
    expect(paginationSiblingsForWidth(450)).toBe(2);
    expect(paginationSiblingsForWidth(1200)).toBe(4);
  });
});

describe("pageJumpTarget", () => {
  it("lands on the typed page", () => {
    expect(pageJumpTarget(" 12 ", 20)).toBe(12);
  });

  it("clamps a page outside the existing pages", () => {
    expect(pageJumpTarget("0", 20)).toBe(1);
    expect(pageJumpTarget("999", 20)).toBe(20);
  });

  it("names no page for empty or non-numeric text", () => {
    expect(pageJumpTarget("", 20)).toBeNull();
    expect(pageJumpTarget("3.5", 20)).toBeNull();
    expect(pageJumpTarget("-2", 20)).toBeNull();
  });
});

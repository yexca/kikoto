import { describe, expect, it } from "vitest";

import { currentPageSelection, pageAfterUnlinkedDelete, setCurrentPageSelected } from "./unlinkedWorksModel";

describe("unlinked work maintenance selection", () => {
  it("reports checked and indeterminate state for only the current page", () => {
    expect(currentPageSelection([1, 2, 3], new Set([1, 3, 99]))).toEqual({
      checked: false,
      indeterminate: true,
      selectedCount: 2,
    });
    expect(currentPageSelection([1, 2], new Set([1, 2, 99]))).toEqual({
      checked: true,
      indeterminate: false,
      selectedCount: 2,
    });
  });

  it("selects and clears current-page ids without changing other ids", () => {
    const selected = setCurrentPageSelected([1, 2], new Set([2, 99]), true);
    expect([...selected].sort((left, right) => left - right)).toEqual([1, 2, 99]);
    expect([...setCurrentPageSelected([1, 2], selected, false)]).toEqual([99]);
  });

  it("moves back when deleting the only row on the last page", () => {
    expect(pageAfterUnlinkedDelete(3, 51, 25, 1)).toBe(2);
    expect(pageAfterUnlinkedDelete(2, 50, 25, 1)).toBe(2);
    expect(pageAfterUnlinkedDelete(1, 1, 25, 1)).toBe(1);
  });
});

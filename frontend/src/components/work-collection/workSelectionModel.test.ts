import { describe, expect, it } from "vitest";

import { retainVisibleSelection } from "@/components/work-collection/workSelectionModel";

const keyOf = (work: { primaryCode: string }) => work.primaryCode;

describe("retainVisibleSelection", () => {
  it("keeps the same set when every selected item is still visible", () => {
    const current = new Set(["RJ00000001"]);
    const items = [{ primaryCode: "RJ00000001" }, { primaryCode: "RJ00000002" }];

    expect(retainVisibleSelection(current, items, keyOf)).toBe(current);
    expect(retainVisibleSelection(current, [...items], keyOf)).toBe(current);
  });

  it("keeps an empty selection when the visible items change", () => {
    const current = new Set<string>();

    expect(retainVisibleSelection(current, [], keyOf)).toBe(current);
  });

  it("drops selected items that are no longer visible", () => {
    const current = new Set(["RJ00000001", "RJ00000002"]);

    expect(retainVisibleSelection(current, [{ primaryCode: "RJ00000002" }], keyOf)).toEqual(new Set(["RJ00000002"]));
  });
});

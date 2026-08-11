import { describe, expect, it } from "vitest";

import { normalizeCatalogSyncState } from "@/lib/catalogSyncState";

describe("normalizeCatalogSyncState", () => {
  it.each([
    ["never", "never"],
    ["attention", "attention"],
    ["synced", "synced"],
    ["not_applicable", "not_applicable"],
    ["fresh", "synced"],
    ["pending", "never"],
    ["stale", "attention"],
    ["excluded", "not_applicable"],
    [undefined, "attention"],
    ["unknown", "attention"],
  ])("maps %p to %s", (state, expected) => {
    expect(normalizeCatalogSyncState(state)).toBe(expected);
  });
});

import { describe, expect, it } from "vitest";
import {
  changeMetadataTagOverride,
  metadataTagOverrideKey,
  exactMetadataTag,
  sameMetadataTagName,
} from "./metadataTagModel";

describe("metadata tag drafts", () => {
  it("reuses exact names in any language after trimming and ignoring case", () => {
    const tag = {
      id: 1,
      key: "custom:synthetic",
      displayName: "Synthetic display",
      dlsiteGenreId: null,
      source: "manual",
      hidden: false,
      mergedIntoTagId: null,
      mergedFromTagIds: [],
      workCount: 0,
      pendingWorkCount: 0,
      resolvedHidden: false,
      names: [{ language: "en-us", name: "Synthetic alternate", source: "manual" as const }],
    };
    expect(sameMetadataTagName(" Synthetic NAME ", "synthetic name")).toBe(true);
    expect(exactMetadataTag([tag], " SYNTHETIC ALTERNATE ")).toBe(tag);
    expect(exactMetadataTag([tag], "Synthetic")).toBeUndefined();
  });
  it("replaces only the chosen action and compares the whole draft without ordering", () => {
    const initial = [
      { tagId: 1, action: "add" as const },
      { tagId: 2, action: "remove" as const },
    ];
    expect(metadataTagOverrideKey(initial)).toBe(metadataTagOverrideKey([...initial].reverse()));
    const changed = changeMetadataTagOverride(initial, 1, "remove");
    expect(changed).toEqual([
      { tagId: 2, action: "remove" },
      { tagId: 1, action: "remove" },
    ]);
    expect(metadataTagOverrideKey(changed)).not.toBe(metadataTagOverrideKey(initial));
    expect(metadataTagOverrideKey(changeMetadataTagOverride(changed, 1, "add"))).toBe(metadataTagOverrideKey(initial));
  });
});

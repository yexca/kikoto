import { describe, expect, it } from "vitest";
import {
  changeMetadataTagOverride,
  changedMetadataTagNames,
  manualMetadataTagNames,
  providerMetadataTagName,
  metadataTagOverrideKey,
  exactMetadataTag,
  metadataTagLanguageName,
  otherMetadataTagNames,
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

describe("metadata tag names", () => {
  const names = [
    { language: "", name: "Synthetic manual", source: "manual" },
    { language: "zh-cn", name: "Synthetic provider", source: "dlsite" },
  ];
  it("separates manual names from provider hints", () => {
    expect(manualMetadataTagNames({ names })).toEqual({ "": "Synthetic manual" });
    expect(providerMetadataTagName({ names }, "zh-cn")).toBe("Synthetic provider");
    expect(providerMetadataTagName({ names }, "")).toBeUndefined();
  });
  it("sends only touched languages whose trimmed name changed, clearing with an empty name", () => {
    const previous = manualMetadataTagNames({ names });
    expect(changedMetadataTagNames({}, previous)).toEqual({});
    expect(changedMetadataTagNames({ "": " Synthetic manual ", "en-us": " " }, previous)).toEqual({});
    expect(changedMetadataTagNames({ "": "", "zh-cn": " Synthetic edit " }, previous)).toEqual({
      "": "",
      "zh-cn": "Synthetic edit",
    });
  });
});

describe("metadata tag names by language", () => {
  const tag = {
    displayName: "Synthetic Japanese",
    names: [
      { language: "ja-jp", name: "Synthetic authored Japanese", source: "manual" },
      { language: "ja-jp", name: "Synthetic Japanese", source: "dlsite" },
      { language: "en-us", name: "Synthetic English", source: "dlsite" },
      { language: "en-us", name: "Synthetic remote English", source: "provider" },
      { language: "zh-cn", name: "Synthetic remote Chinese", source: "provider" },
      { language: "", name: "Synthetic unlabeled", source: "provider" },
    ],
  };

  it("shows each language's name in the server's precedence", () => {
    expect(metadataTagLanguageName(tag, "ja-jp")?.name).toBe("Synthetic authored Japanese");
    expect(metadataTagLanguageName(tag, "en-us")?.name).toBe("Synthetic English");
    expect(metadataTagLanguageName(tag, "zh-cn")?.name).toBe("Synthetic remote Chinese");
    expect(metadataTagLanguageName(tag, "ko-kr")).toBeUndefined();
    // An all-language manual name applies before dictionary names.
    const universal = { names: [...tag.names, { language: "", name: "Synthetic universal", source: "manual" }] };
    expect(metadataTagLanguageName(universal, "en-us")?.name).toBe("Synthetic universal");
    expect(metadataTagLanguageName(universal, "ja-jp")?.name).toBe("Synthetic authored Japanese");
  });

  it("lists every name no language shows once, including a stored name without records", () => {
    expect(otherMetadataTagNames(tag).map((name) => [name.language, name.name])).toEqual([
      ["ja-jp", "Synthetic Japanese"],
      ["en-us", "Synthetic remote English"],
      ["", "Synthetic unlabeled"],
    ]);
    expect(otherMetadataTagNames({ displayName: " Synthetic legacy ", names: [] })).toEqual([
      { language: "", name: "Synthetic legacy", source: "stored" },
    ]);
  });
});

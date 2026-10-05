import type { MetadataTagOverride } from "./api";
import type { MetadataTag } from "./api";

export function sameMetadataTagName(left: string, right: string) {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}
export function exactMetadataTag(entries: MetadataTag[], name: string) {
  return entries.find(
    (entry) =>
      sameMetadataTagName(entry.displayName, name) ||
      entry.names.some((value) => sameMetadataTagName(value.name, name)),
  );
}

export function metadataTagOverrideKey(overrides: MetadataTagOverride[]): string {
  return JSON.stringify([...overrides].sort((a, b) => a.tagId - b.tagId));
}

export function changeMetadataTagOverride(
  overrides: MetadataTagOverride[],
  tagId: number,
  action: MetadataTagOverride["action"],
): MetadataTagOverride[] {
  return [...overrides.filter((entry) => entry.tagId !== tagId), { tagId, action }];
}

export const metadataTagLanguages = [
  ["", "metadataEntries.allLanguages"],
  ["ja-jp", "metadata.japanese"],
  ["zh-cn", "metadata.simplifiedChinese"],
  ["zh-tw", "metadata.traditionalChinese"],
  ["en-us", "metadata.english"],
  ["ko-kr", "metadata.korean"],
] as const;

/** A tag's own manual names by language; provider and dictionary names are hints. */
export function manualMetadataTagNames(tag: Pick<MetadataTag, "names">): Record<string, string> {
  return Object.fromEntries(
    tag.names.filter((name) => name.source === "manual").map((name) => [name.language, name.name]),
  );
}

/** The provider or dictionary name a language shows when it has no manual name. */
export function providerMetadataTagName(tag: Pick<MetadataTag, "names">, language: string) {
  return tag.names.find((name) => name.language === language && name.source !== "manual")?.name;
}

/**
 * Trimmed names that differ from the saved manual names, for the languages a
 * draft touched. An empty value removes that language's manual name.
 */
export function changedMetadataTagNames(
  drafts: Record<string, string>,
  previous: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    metadataTagLanguages
      .filter(([language]) => language in drafts)
      .map(([language]) => [language, drafts[language].trim()] as const)
      .filter(([language, name]) => name !== (previous[language] ?? "")),
  );
}

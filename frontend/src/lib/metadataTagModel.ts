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

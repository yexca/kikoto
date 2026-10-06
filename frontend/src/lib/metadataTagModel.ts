import type { MetadataTagOverride } from "./api";
import type { MetadataTag } from "./api";

export function sameMetadataTagName(left: string, right: string) {
  return sameNameKey(left) === sameNameKey(right);
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

type MetadataTagName = MetadataTag["names"][number];

/** The languages a tag list shows as columns; every other name is listed as Other. */
export const metadataTagNameLanguages = metadataTagLanguages.filter(([language]) => language !== "");

/**
 * The name a language shows for a tag, in the server's precedence: that
 * language's manual name, the all-language manual name, the DLsite dictionary
 * name, then a remote source's name.
 */
export function metadataTagLanguageName(
  tag: Pick<MetadataTag, "names">,
  language: string,
): MetadataTagName | undefined {
  const find = (source: string, nameLanguage: string) =>
    tag.names.find((name) => name.source === source && name.language === nameLanguage && name.name.trim() !== "");
  return find("manual", language) ?? find("manual", "") ?? find("dlsite", language) ?? find("provider", language);
}

/**
 * Every known name no language column shows, once each ignoring case: names
 * a manual name replaced, names without a language, and a stored display
 * name that has no name record.
 */
export function otherMetadataTagNames(tag: Pick<MetadataTag, "names" | "displayName">): MetadataTagName[] {
  const seen = new Set<string>();
  for (const [language] of metadataTagNameLanguages) {
    const shown = metadataTagLanguageName(tag, language);
    if (shown) seen.add(sameNameKey(shown.name));
  }
  const result: MetadataTagName[] = [];
  const add = (name: MetadataTagName) => {
    const key = sameNameKey(name.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push({ ...name, name: name.name.trim() });
  };
  tag.names.forEach(add);
  add({ language: "", name: tag.displayName, source: "stored" });
  return result;
}

function sameNameKey(name: string) {
  return name.trim().toLocaleLowerCase();
}

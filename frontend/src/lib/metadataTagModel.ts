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

/** The supported metadata languages, without the all-language scope. */
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
  return (
    find("manual", language) ??
    find("manual", "") ??
    find("dlsite", language) ??
    find("provider", language) ??
    find("llm", language)
  );
}

/**
 * The name a tag shows in one language once a draft of its manual names is
 * saved: a drafted name replaces that language's manual name and an empty
 * draft removes it. `own` is false when the language has no name of its own
 * and shows the all-language name or the display name.
 */
export function metadataTagNameIn(
  tag: { names?: MetadataTagName[]; displayName: string },
  language: string,
  drafts: Record<string, string> = {},
): { name: string; own: boolean } {
  const names: MetadataTagName[] = [
    ...Object.entries(drafts).map(([draftLanguage, name]) => ({ language: draftLanguage, name, source: "manual" })),
    ...(tag.names ?? []).filter((name) => !(name.source === "manual" && name.language in drafts)),
  ];
  const shown = metadataTagLanguageName({ names }, language);
  return shown ? { name: shown.name.trim(), own: shown.language === language } : { name: tag.displayName, own: false };
}

/**
 * The tag's display name and its own names in the supported languages, apart
 * from the one already shown, once each ignoring case. A list row offers them
 * as the tag's other names.
 */
export function metadataTagAlternateNames(
  tag: { names?: MetadataTagName[]; displayName: string },
  shown: string,
  drafts: Record<string, string> = {},
): string[] {
  const seen = new Set([sameNameKey(shown)]);
  const candidates = [
    tag.displayName,
    ...metadataTagNameLanguages
      .map(([language]) => metadataTagNameIn(tag, language, drafts))
      .filter((name) => name.own)
      .map((name) => name.name),
  ];
  return candidates
    .map((name) => name.trim())
    .filter((name) => {
      const key = sameNameKey(name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Whether a name is the tag's display name or any of its names, ignoring case. */
export function metadataTagHasName(tag: { names?: MetadataTagName[]; displayName: string }, name: string) {
  return (
    sameMetadataTagName(tag.displayName, name) ||
    (tag.names ?? []).some((value) => sameMetadataTagName(value.name, name))
  );
}

function sameNameKey(name: string) {
  return name.trim().toLocaleLowerCase();
}

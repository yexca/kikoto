import type { MediaItem, MediaLyricsAssignment } from "@/lib/mediaApi";
import { metadataTagLanguages } from "@/lib/metadataTagModel";

/** The lyrics that apply to every language: the fallback when a listener's languages have none. */
export const allLyricsLanguages = "";

/**
 * The languages library lyrics can declare, with their label keys: the
 * fallback first, then the languages titles and tag names are saved in.
 */
export const lyricsLanguages: readonly (readonly [string, string])[] = metadataTagLanguages.map(
  ([language, labelKey]) => [language, language === allLyricsLanguages ? "lyricsManager.fallback" : labelKey] as const,
);

const providerSpellings: Record<string, string> = {
  ja: "ja-jp",
  jp: "ja-jp",
  jpn: "ja-jp",
  en: "en-us",
  eng: "en-us",
  zh: "zh-cn",
  cn: "zh-cn",
  "chi-hans": "zh-cn",
  "chi-simp": "zh-cn",
  "chi-hans-cn": "zh-cn",
  tw: "zh-tw",
  "chi-hant": "zh-tw",
  "chi-trad": "zh-tw",
  "chi-hant-tw": "zh-tw",
  ko: "ko-kr",
  kor: "ko-kr",
};

/**
 * Maps an edition's declared language onto a lyrics language, and onto every
 * language when lyrics cannot declare it.
 */
export function editionLyricsLanguage(editionLanguage: string): string {
  const language = editionLanguage.trim().toLowerCase().replace(/_/g, "-");
  const normalized = providerSpellings[language] ?? language;
  return lyricsLanguages.some(([value]) => value === normalized) ? normalized : allLyricsLanguages;
}

/** The folder inside a work folder that holds the lyrics Kikoto manages. */
export const lyricsRootFolderName = "lyrics_kikoto";

/**
 * The folder inside the lyrics folder that holds the lyrics Kikoto adds for a
 * language. It mirrors the server's naming.
 */
export function lyricsLanguageFolderName(language: string): string {
  switch (language) {
    case "ja-jp":
      return "ja";
    case "en-us":
      return "en";
    case "zh-cn":
      return "zh-hans";
    case "zh-tw":
      return "zh-hant";
    case "ko-kr":
      return "ko";
    default:
      return "fallback";
  }
}

/** The folder, relative to a work folder, that holds a language's lyrics; shown before a change. */
export function lyricsLanguageFolderPath(language: string): string {
  return `${lyricsRootFolderName}/${lyricsLanguageFolderName(language)}`;
}

/**
 * The language whose folder inside the lyrics folder has this name, or null
 * for any other folder.
 */
export function lyricsFolderLanguage(name: string): string | null {
  return lyricsLanguages.find(([language]) => lyricsLanguageFolderName(language) === name)?.[0] ?? null;
}

/** The translation key naming a lyrics language, or null for an unknown one. */
export function lyricsLanguageLabelKey(language: string) {
  return lyricsLanguages.find(([value]) => value === language)?.[1] ?? null;
}

/**
 * A track's library lyrics in playback order. Media loaded before lyrics had
 * languages carries only the single assigned file.
 */
export function mediaItemLyricsAssignments(
  item: Pick<MediaItem, "lyricsAssignments" | "assignedLyricsMediaItemId"> | null | undefined,
): MediaLyricsAssignment[] {
  if (!item) return [];
  if (item.lyricsAssignments?.length) return item.lyricsAssignments;
  return item.assignedLyricsMediaItemId
    ? [{ language: allLyricsLanguages, lyricsMediaItemId: item.assignedLyricsMediaItemId }]
    : [];
}

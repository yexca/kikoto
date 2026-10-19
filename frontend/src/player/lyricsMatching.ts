import type { MediaItem, MediaLyricsAssignment } from "@/lib/api";

// The server reports a work's lyrics status with a copy of this name matching in
// backend/internal/httpapi/lyrics_match.go. Both must accept the same track and
// lyrics pairs, so change them together.
const lyricExtensions = [".lrc", ".vtt", ".srt", ".ass", ".txt", ".cue"];
const audioExtensions = [".mp3", ".m4a", ".flac", ".wav", ".wma", ".ogg", ".opus", ".aac"];
const sharedLyricNames = new Set(["lyrics", "lyric", "subtitle", "subtitles", "字幕", "翻译", "翻譯"]);

export type LyricsMatch = {
  mediaItemId: number;
  locationId: number;
  title: string;
  path: string;
  displayPath?: string;
  reason: "assigned" | "exact_sidecar" | "same_stem" | "normalized_name" | "shared_folder";
  /** The language an assigned file declares; empty or absent when it declares none. */
  language?: string;
};

export type LyricsChoice = LyricsMatch & { url?: string };

export type RemoteLyricsCandidate = {
  mediaItemId: number;
  locationId: number;
  title: string;
  path: string;
  url: string;
};

export type RemoteLyricsMatch = LyricsMatch & { url: string };

export function findLyricsMatch(audioPath: string, items: MediaItem[]): LyricsMatch | null {
  return findLyricsMatches(audioPath, items)[0] ?? null;
}

export function findLyricsMatches(audioPath: string, items: MediaItem[]): LyricsMatch[] {
  const audioName = fileName(audioPath);
  const audioDirectory = directoryName(audioPath);
  const audioStem = stripLastExtension(audioName);
  const normalizedAudioStem = normalizeMediaName(audioStem);
  const candidates = items
    .flatMap((item) =>
      item.locations
        .filter(
          (location) =>
            location.locationType === "local" && location.availability === "available" && isLyricsPath(location.path),
        )
        .map((location) =>
          scoreCandidate(
            item.id,
            location.id,
            location.path,
            audioName,
            audioStem,
            normalizedAudioStem,
            audioDirectory,
          ),
        ),
    )
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
    );
  return candidates.map((candidate) => ({
    mediaItemId: candidate.mediaItemId,
    locationId: candidate.locationId,
    title: fileName(candidate.path),
    path: candidate.path,
    reason: candidate.reason,
  }));
}

/**
 * Lists the lyrics choices of a local audio file. Library-level assignments
 * lead the list in the given order, which is the order the viewer's languages
 * rank them, even when their names do not match; the first becomes the
 * automatic choice. Name matches follow in their usual order.
 */
export function findLocalLyricsChoices(
  audioPath: string,
  items: MediaItem[],
  assignments: readonly MediaLyricsAssignment[] = [],
): LyricsMatch[] {
  const assigned: LyricsMatch[] = [];
  for (const assignment of assignments) {
    if (assigned.some((choice) => choice.mediaItemId === assignment.lyricsMediaItemId)) continue;
    const choice = assignedLyricsChoice(items, assignment);
    if (choice) assigned.push(choice);
  }
  const matches = findLyricsMatches(audioPath, items);
  if (assigned.length === 0) return matches;
  return [
    ...assigned,
    ...matches.filter((match) => !assigned.some((choice) => choice.mediaItemId === match.mediaItemId)),
  ];
}

function assignedLyricsChoice(items: MediaItem[], assignment: MediaLyricsAssignment): LyricsMatch | null {
  const item = items.find((candidate) => candidate.id === assignment.lyricsMediaItemId);
  const location = item?.locations.find(
    (candidate) => candidate.locationType === "local" && candidate.availability === "available",
  );
  if (!item || !location) return null;
  return {
    mediaItemId: item.id,
    locationId: location.id,
    title: fileName(location.path),
    path: location.path,
    reason: "assigned",
    language: assignment.language,
  };
}

export function findRemoteLyricsMatches(audioPath: string, candidates: RemoteLyricsCandidate[]): RemoteLyricsMatch[] {
  const audioName = fileName(audioPath);
  const audioDirectory = directoryName(audioPath);
  const audioStem = stripLastExtension(audioName);
  const normalizedAudioStem = normalizeMediaName(audioStem);
  const scored = candidates.flatMap((candidate) => {
    if (!candidate.url || !isLyricsPath(candidate.path)) return [];
    const match = scoreCandidate(
      candidate.mediaItemId,
      candidate.locationId,
      candidate.path,
      audioName,
      audioStem,
      normalizedAudioStem,
      audioDirectory,
    );
    return match ? [{ ...match, url: candidate.url }] : [];
  });
  return scored
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
    )
    .map(({ mediaItemId, locationId, path, reason, url }) => ({
      mediaItemId,
      locationId,
      title: fileName(path),
      path,
      reason,
      url,
    }));
}

export function isLyricsPath(path: string) {
  const lower = path.toLowerCase();
  return lyricExtensions.some((extension) => lower.endsWith(extension));
}

/**
 * The label of a lyrics choice. `languageName` names a declared language, which
 * then leads the label so choices in different languages are told apart.
 */
export function lyricsChoiceDisplayLabel(
  choice: LyricsChoice,
  choices: LyricsChoice[],
  languageName?: (language: string) => string,
) {
  const duplicateTitle = choices.some(
    (candidate) =>
      candidate.locationId !== choice.locationId &&
      candidate.title.localeCompare(choice.title, undefined, { sensitivity: "base" }) === 0,
  );
  const name = duplicateTitle
    ? choice.displayPath?.trim() || compactLyricsPath(choice.path) || choice.title
    : choice.title;
  const language = choice.language ? languageName?.(choice.language) : "";
  return language ? `${language} · ${name}` : name;
}

function scoreCandidate(
  mediaItemId: number,
  locationId: number,
  path: string,
  audioName: string,
  audioStem: string,
  normalizedAudioStem: string,
  audioDirectory: string,
) {
  const lyricName = fileName(path);
  const lyricDirectory = directoryName(path);
  const lyricBase = stripKnownExtension(lyricName, lyricExtensions);
  const lyricStem = stripKnownExtension(lyricBase, audioExtensions);
  const sameDirectory = matchKey(lyricDirectory) === matchKey(audioDirectory);
  let score = sameDirectory ? 1000 : 0;
  let reason: LyricsMatch["reason"] | null = null;

  if (sameDirectory && matchKey(lyricBase) === matchKey(audioName)) {
    score += 10000;
    reason = "exact_sidecar";
  } else if (matchKey(lyricStem) === matchKey(audioStem)) {
    score += 7000;
    reason = "same_stem";
  } else if (
    normalizeMediaName(lyricStem) === normalizedAudioStem &&
    normalizedAudioStem.length >= 2 &&
    numbersAgree(nameNumbers(lyricStem), nameNumbers(audioStem))
  ) {
    score += 4000;
    reason = "normalized_name";
  } else if (sameDirectory && sharedLyricNames.has(normalizeMediaName(lyricStem))) {
    score += 500;
    reason = "shared_folder";
  }
  if (!reason) return null;
  score += lyricFormatPreference(lyricName);
  return { mediaItemId, locationId, path, reason, score };
}

function lyricFormatPreference(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".lrc")) return 6;
  if (lower.endsWith(".vtt")) return 5;
  if (lower.endsWith(".srt")) return 4;
  if (lower.endsWith(".ass")) return 3;
  if (lower.endsWith(".txt")) return 2;
  return 1;
}

/**
 * A sound effect or music switch, such as "SEあり", "SE無し", or "BGM OFF".
 * One lyrics file serves every variant, so the switch folds away. It is applied
 * twice so adjacent switches that share one separator both fold.
 */
const variantPattern = /(^|[^a-z0-9])(?:se|bgm|効果音)[\s﻿_.-]*(?:あり|有り|有|なし|無し|無|on|off)([^a-z0-9]|$)/g;

/** The form names are compared in: composed (NFC) and lowercased. Stored paths keep their own form. */
function matchKey(value: string) {
  return value.normalize("NFC").toLowerCase();
}

/** The numbers of a name outside brackets without leading zeros, so "track 1" and "01" carry the same number. */
function nameNumbers(value: string) {
  return (value.replace(/\[[^\]]*\]|\([^)]*\)/g, "").match(/[0-9]+/g) ?? []).map(
    (number) => number.replace(/^0+(?=.)/, "") || "0",
  );
}

/** Names that differ only in their numbers, such as "01_abc" and "02_abc", name different tracks. */
function numbersAgree(left: string[], right: string[]) {
  return left.length === 0 || right.length === 0 || left.join(",") === right.join(",");
}

function normalizeMediaName(value: string) {
  return matchKey(value)
    .replace(variantPattern, "$1$2")
    .replace(variantPattern, "$1$2")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/^(track|tr|disc|cd)[\s_.-]*/i, "")
    .replace(/^[0-9]+[\s_.-]*/, "")
    .replace(/[\s_.\-()[\]【】「」『』]+/g, "");
}

function stripKnownExtension(value: string, extensions: string[]) {
  const lower = value.toLowerCase();
  const extension = extensions.find((candidate) => lower.endsWith(candidate));
  return extension ? value.slice(0, -extension.length) : value;
}

function stripLastExtension(value: string) {
  const index = value.lastIndexOf(".");
  return index > 0 ? value.slice(0, index) : value;
}

function fileName(path: string) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function directoryName(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function compactLyricsPath(path: string) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

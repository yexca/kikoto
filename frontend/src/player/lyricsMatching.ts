import type { LyricsAIModels, LyricsChoiceReason, MediaFileLocation, MediaItem } from "@/lib/api";

// The server ranks the lyrics choices of every track: the work media lists
// them on each audio and video location, and a remote edition's tree on each
// audio and video file. This module turns those choices into the files the
// player reads; it never decides which lyrics belong to a track.

/** The formats lyrics are read from. A .cue file is a CUE sheet, the track layout of a disc image, never lyrics. */
const lyricExtensions = [".lrc", ".vtt", ".srt", ".ass", ".ssa", ".txt"];
// The same list as audioFileExtensions in backend/internal/httpapi/media_items.go.
export const audioExtensions = [
  ".mp3",
  ".m4a",
  ".flac",
  ".wav",
  ".wma",
  ".ogg",
  ".oga",
  ".opus",
  ".aac",
  ".aiff",
  ".aif",
  ".mka",
];

export type LyricsMatch = {
  mediaItemId: number;
  locationId: number;
  title: string;
  path: string;
  displayPath?: string;
  reason: LyricsChoiceReason;
  /** The language an assigned file declares; empty or absent when it declares none. */
  language?: string;
  /** The models that wrote the file, when speech recognition or translation made it. */
  ai?: LyricsAIModels;
};

export type LyricsChoice = LyricsMatch & { url?: string };

/** The local lyrics files of a work by location, to resolve the choices the server ranks. */
export type LocalLyricsFiles = ReadonlyMap<number, { item: MediaItem; location: MediaFileLocation }>;

export function localLyricsFiles(items: readonly MediaItem[]): LocalLyricsFiles {
  const files = new Map<number, { item: MediaItem; location: MediaFileLocation }>();
  for (const item of items) {
    for (const location of item.locations) {
      if (location.locationType === "local") files.set(location.id, { item, location });
    }
  }
  return files;
}

/**
 * The lyrics choices of a track location in the server's order: its library
 * assignments in the order the viewer's languages rank them, then its name
 * matches. The first is the automatic choice.
 */
export function localLyricsChoices(
  location: Pick<MediaFileLocation, "lyricsChoices"> | undefined,
  files: LocalLyricsFiles,
): LyricsMatch[] {
  return (location?.lyricsChoices ?? []).flatMap((choice): LyricsMatch[] => {
    const file = files.get(choice.locationId);
    if (!file) return [];
    return [
      {
        mediaItemId: choice.lyricsMediaItemId,
        locationId: choice.locationId,
        title: fileName(file.location.path),
        path: file.location.path,
        reason: choice.reason,
        ...(choice.language !== undefined ? { language: choice.language } : {}),
        ...(choice.reason === "assigned" && file.item.aiLyrics ? { ai: file.item.aiLyrics } : {}),
      },
    ];
  });
}

const sidecarSubtitleExtensions = [".vtt", ".srt", ".ass", ".ssa"];

/**
 * The WebVTT, SRT, ASS, and SSA files beside a video that share its name, such as
 * `clip.vtt` or `clip.mp4.srt` for `clip.mp4`, in the order of `choices`.
 */
export function sidecarSubtitleChoices(videoPath: string, choices: LyricsChoice[]) {
  const videoName = fileName(videoPath);
  const videoDirectory = matchKey(directoryName(videoPath));
  const videoStem = matchKey(stripLastExtension(videoName));
  return choices.filter((choice) => {
    const path = choice.displayPath || choice.path;
    const name = fileName(path);
    const lower = name.toLowerCase();
    const extension = sidecarSubtitleExtensions.find((candidate) => lower.endsWith(candidate));
    if (!extension || matchKey(directoryName(path)) !== videoDirectory) return false;
    const base = matchKey(name.slice(0, -extension.length));
    return base === matchKey(videoName) || base === videoStem;
  });
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

/** The form names are compared in: composed (NFC) and lowercased. Stored paths keep their own form. */
function matchKey(value: string) {
  return value.normalize("NFC").toLowerCase();
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

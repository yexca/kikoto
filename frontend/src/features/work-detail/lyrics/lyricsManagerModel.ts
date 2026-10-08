import type { LyricsAssignmentChange, MediaItem } from "@/lib/api";
import { parseTimedLyrics } from "@/lib/timedLyrics";
import { findLyricsMatches, isLyricsPath } from "@/player/lyricsMatching";

/** An audio file of the work as the lyrics manager lists it. */
export type LyricsManagerAudio = {
  mediaItemId: number;
  title: string;
  /** Path below the work's common local folder. */
  path: string;
  folder: string;
  durationSeconds: number | null;
  assignedLyricsMediaItemId: number | null;
  /** The name match used when no assignment exists. */
  autoLyricsMediaItemId: number | null;
};

/** A local lyrics file that an audio file can be assigned to. */
export type LyricsManagerFile = {
  mediaItemId: number;
  locationId: number;
  title: string;
  path: string;
  folder: string;
};

export type LyricsManagerEntries = {
  audio: LyricsManagerAudio[];
  lyrics: LyricsManagerFile[];
};

/** Desired library assignment per audio media item; null restores automatic matching. */
export type LyricsAssignmentDraft = ReadonlyMap<number, number | null>;

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Lyrics whose last line starts this long after the audio ends probably belong to another track. */
export const lyricsTimingToleranceSeconds = 5;

export function lyricsManagerEntries(items: MediaItem[]): LyricsManagerEntries {
  const local = items.flatMap((item) => {
    const location = item.locations.find(
      (candidate) => candidate.locationType === "local" && candidate.availability === "available",
    );
    return location ? [{ item, location, path: normalizePath(location.path) }] : [];
  });
  const root = commonDirectory(local.map((entry) => entry.path));
  const relative = (path: string) => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);
  const audio = local
    .filter(({ item }) => item.kind === "audio")
    .map(({ item, location, path }) => {
      const displayPath = relative(path);
      return {
        mediaItemId: item.id,
        title: fileName(displayPath),
        path: displayPath,
        folder: directoryName(displayPath),
        durationSeconds: location.durationSeconds ?? item.durationSeconds,
        assignedLyricsMediaItemId: item.assignedLyricsMediaItemId ?? null,
        autoLyricsMediaItemId: findLyricsMatches(path, items)[0]?.mediaItemId ?? null,
      };
    })
    .sort(comparePaths);
  const lyrics = local
    .filter(({ item, path }) => item.kind !== "audio" && item.kind !== "video" && isLyricsPath(path))
    .map(({ item, location, path }) => {
      const displayPath = relative(path);
      return {
        mediaItemId: item.id,
        locationId: location.id,
        title: fileName(displayPath),
        path: displayPath,
        folder: directoryName(displayPath),
      };
    })
    .sort(comparePaths);
  return { audio, lyrics };
}

export function initialLyricsAssignmentDraft(audio: LyricsManagerAudio[]): Map<number, number | null> {
  return new Map(audio.map((entry) => [entry.mediaItemId, entry.assignedLyricsMediaItemId]));
}

/**
 * Moves the draft onto reloaded entries, for example after a download stored
 * new assignments: rows the user edited keep their edit, others take the new
 * stored value.
 */
export function rebaseLyricsAssignmentDraft(
  previous: LyricsManagerAudio[],
  next: LyricsManagerAudio[],
  draft: LyricsAssignmentDraft,
): Map<number, number | null> {
  const stored = new Map(previous.map((entry) => [entry.mediaItemId, entry.assignedLyricsMediaItemId]));
  return new Map(
    next.map((entry) => {
      const id = entry.mediaItemId;
      const edited = draft.has(id) && stored.has(id) && draft.get(id) !== stored.get(id);
      return [id, edited ? (draft.get(id) ?? null) : entry.assignedLyricsMediaItemId];
    }),
  );
}

/** The changes needed to turn the stored assignments into the draft. */
export function lyricsAssignmentChanges(
  audio: LyricsManagerAudio[],
  draft: LyricsAssignmentDraft,
): LyricsAssignmentChange[] {
  return audio.flatMap((entry) => {
    if (!draft.has(entry.mediaItemId)) return [];
    const next = draft.get(entry.mediaItemId) ?? null;
    return next === entry.assignedLyricsMediaItemId
      ? []
      : [{ audioMediaItemId: entry.mediaItemId, lyricsMediaItemId: next }];
  });
}

/** The lyrics file an audio file will use: its draft assignment, else its name match. */
export function effectiveLyricsMediaItemId(entry: LyricsManagerAudio, draft: LyricsAssignmentDraft) {
  const assigned = draft.has(entry.mediaItemId) ? draft.get(entry.mediaItemId) : entry.assignedLyricsMediaItemId;
  return assigned ?? entry.autoLyricsMediaItemId;
}

export function lyricsFolders(lyrics: LyricsManagerFile[]) {
  const counts = new Map<string, number>();
  for (const file of lyrics) counts.set(file.folder, (counts.get(file.folder) ?? 0) + 1);
  return [...counts.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .sort((left, right) => right.count - left.count || naturalCollator.compare(left.folder, right.folder));
}

/**
 * Pairs each audio folder with the lyrics of one folder by track order. When
 * every file on both sides starts with a distinct track number, numbers are
 * matched; otherwise a folder is paired by position only when the counts are
 * equal. Translated editions rename files, so their names cannot be compared.
 */
export function alignLyricsByOrder(
  audio: LyricsManagerAudio[],
  lyrics: LyricsManagerFile[],
  lyricsFolder: string,
): Map<number, number> {
  const candidates = lyrics.filter((file) => file.folder === lyricsFolder).sort(comparePaths);
  const result = new Map<number, number>();
  if (candidates.length === 0) return result;
  const lyricsByNumber = uniqueTrackNumbers(candidates);
  const audioByFolder = new Map<string, LyricsManagerAudio[]>();
  for (const entry of audio) audioByFolder.set(entry.folder, [...(audioByFolder.get(entry.folder) ?? []), entry]);
  for (const entries of audioByFolder.values()) {
    const sorted = [...entries].sort(comparePaths);
    const audioByNumber = uniqueTrackNumbers(sorted);
    if (lyricsByNumber && audioByNumber) {
      for (const [number, entry] of audioByNumber) {
        const match = lyricsByNumber.get(number);
        if (match) result.set(entry.mediaItemId, match.mediaItemId);
      }
    } else if (sorted.length === candidates.length) {
      sorted.forEach((entry, index) => result.set(entry.mediaItemId, candidates[index].mediaItemId));
    }
  }
  return result;
}

export type LyricsTimingCheck = {
  timed: boolean;
  lineCount: number;
  lastLineSeconds: number | null;
  exceedsAudio: boolean;
};

/** Checks whether timed lyrics fit the audio they are assigned to. */
export function lyricsTimingCheck(text: string, durationSeconds: number | null): LyricsTimingCheck {
  const parsed = parseTimedLyrics(text);
  const lastLineSeconds = parsed.lines.length > 0 ? parsed.lines[parsed.lines.length - 1].time : null;
  return {
    timed: parsed.timed,
    lineCount: parsed.lines.length,
    lastLineSeconds,
    exceedsAudio:
      lastLineSeconds !== null &&
      durationSeconds !== null &&
      durationSeconds > 0 &&
      lastLineSeconds > durationSeconds + lyricsTimingToleranceSeconds,
  };
}

function uniqueTrackNumbers<T extends { title: string }>(entries: T[]): Map<number, T> | null {
  const result = new Map<number, T>();
  for (const entry of entries) {
    const number = leadingTrackNumber(entry.title);
    if (number === null || result.has(number)) return null;
    result.set(number, entry);
  }
  return result;
}

export function leadingTrackNumber(name: string): number | null {
  const match = name.match(/^\s*(?:track|tr)?[\s_.\-#]*0*(\d{1,3})(?!\d)/i);
  return match ? Number(match[1]) : null;
}

function comparePaths(left: { path: string }, right: { path: string }) {
  return naturalCollator.compare(left.path, right.path);
}

function commonDirectory(paths: string[]) {
  if (paths.length === 0) return "";
  let prefix = directoryName(paths[0]).split("/").filter(Boolean);
  for (const path of paths.slice(1)) {
    const parts = directoryName(path).split("/").filter(Boolean);
    let index = 0;
    while (index < prefix.length && index < parts.length && prefix[index] === parts[index]) index += 1;
    prefix = prefix.slice(0, index);
  }
  return prefix.join("/");
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function fileName(path: string) {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function directoryName(path: string) {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

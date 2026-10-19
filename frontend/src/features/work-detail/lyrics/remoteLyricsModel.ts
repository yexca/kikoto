import { findRemoteLyricsMatches } from "@/player/lyricsMatching";

import {
  alignLyricsByOrder,
  lyricsFolders,
  type LyricsManagerAudio,
  type LyricsManagerFile,
} from "./lyricsManagerModel";

/** Text formats the server accepts as downloadable lyrics. */
const remoteLyricsExtensions = [".lrc", ".vtt", ".srt", ".ass", ".ssa", ".txt"];

/** Whether the server accepts the file at this path as lyrics. */
export function isLyricsFilePath(path: string) {
  const lower = path.toLowerCase();
  return remoteLyricsExtensions.some((extension) => lower.endsWith(extension));
}

/**
 * A lyrics file of the source being added from, addressed by its path in that
 * source: a remote edition's tree path, or a path below a library folder.
 */
export type RemoteLyricsFile = {
  path: string;
  title: string;
  folder: string;
  sizeBytes: number | null;
  /** The file's local location when the source is a library folder. */
  locationId?: number;
};

/**
 * Suggests a remote lyrics file for each local track: a matching file name
 * first, then track order against the remote folder holding the most lyrics.
 */
export function suggestRemoteLyricsMapping(
  audio: LyricsManagerAudio[],
  files: RemoteLyricsFile[],
): Map<number, string | null> {
  const candidates = files.map((file, index) => ({
    mediaItemId: -(index + 1),
    locationId: -(index + 1),
    title: file.title,
    path: file.path,
    url: file.path,
  }));
  const result = new Map<number, string | null>();
  for (const entry of audio) {
    result.set(entry.mediaItemId, findRemoteLyricsMatches(entry.path, candidates)[0]?.path ?? null);
  }
  const pseudoLyrics: LyricsManagerFile[] = files.map((file, index) => ({
    mediaItemId: -(index + 1),
    locationId: -(index + 1),
    title: file.title,
    path: file.path,
    folder: file.folder,
  }));
  const folder = lyricsFolders(pseudoLyrics)[0]?.folder;
  if (folder === undefined) return result;
  const unmatched = audio.filter((entry) => result.get(entry.mediaItemId) === null);
  for (const [audioID, pseudoID] of alignLyricsByOrder(unmatched, pseudoLyrics, folder)) {
    result.set(audioID, files[-pseudoID - 1]?.path ?? null);
  }
  return result;
}

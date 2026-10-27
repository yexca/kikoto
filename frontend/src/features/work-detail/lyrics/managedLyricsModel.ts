import { isLyricsFilePath } from "@/features/work-detail/lyrics/remoteLyricsModel";
import type { MediaItem } from "@/lib/api";
import { lyricsFolderLanguage, lyricsRootFolderName } from "@/lib/lyricsLanguage";

/**
 * The language whose lyrics folder holds a file, by the file's path below its
 * work folder, or null for a file Kikoto does not manage. The empty language
 * is the folder for every language. The server also checks that Kikoto
 * created the lyrics folder before it changes one of these files.
 */
export function managedLyricsLanguage(relativePath: string): string | null {
  const parts = normalizePath(relativePath).split("/");
  if (parts.length < 3 || parts[0] !== lyricsRootFolderName || !isLyricsFilePath(relativePath)) return null;
  return lyricsFolderLanguage(parts[1]);
}

/** A library path's part below a folder root, or null when it lies outside the folder. */
export function pathBelowFolder(rootPath: string, libraryPath: string): string | null {
  const root = normalizePath(rootPath);
  const path = normalizePath(libraryPath);
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/** How many local tracks use each lyrics file as library lyrics, by the file's media item. */
export function lyricsFileTrackCounts(items: MediaItem[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const item of items) {
    if (item.kind !== "audio") continue;
    const used = new Set((item.lyricsAssignments ?? []).map((assignment) => assignment.lyricsMediaItemId));
    for (const lyricsID of used) counts.set(lyricsID, (counts.get(lyricsID) ?? 0) + 1);
  }
  return counts;
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

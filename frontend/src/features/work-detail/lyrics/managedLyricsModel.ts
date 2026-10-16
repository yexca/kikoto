import { isLyricsFilePath } from "@/features/work-detail/lyrics/remoteLyricsModel";
import type { TreeNode, TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import type { MediaItem } from "@/lib/api";
import { lyricsFolderLanguage, lyricsRootFolderName } from "@/lib/lyricsLanguage";

/** A lyrics file of a local work folder, addressed by its path below that folder. */
export type FolderLyricsFile = {
  locationId: number;
  folderId: number;
  path: string;
  title: string;
  sizeBytes: number | null;
};

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

/**
 * Splits a file tree of one local folder into the files file management lists
 * and the lyrics Kikoto manages, which the lyrics manager handles instead.
 */
export function splitManagedLyrics(root: TreeNode, rootPath: string): { listed: TreeNode; managed: TreeTrack[] } {
  const managed: TreeTrack[] = [];
  const prune = (node: TreeNode): TreeNode => {
    const files = node.files.filter((file) => {
      const path = file.localAvailable ? pathBelowFolder(rootPath, file.localPath) : null;
      if (path === null || managedLyricsLanguage(path) === null) return true;
      managed.push(file);
      return false;
    });
    const children = new Map<string, TreeNode>();
    for (const [name, child] of node.children) {
      const pruned = prune(child);
      if (pruned.files.length > 0 || pruned.children.size > 0) children.set(name, pruned);
    }
    return { ...node, files, children };
  };
  const listed = prune(root);
  return managed.length > 0 ? { listed, managed } : { listed: root, managed };
}

/** The lyrics files among selected local files of a folder, for managing them as lyrics. */
export function folderLyricsFiles(
  targets: readonly { kind: string; locationId: number; title: string; path: string; sizeBytes: number | null }[],
  folder: { id: number; rootPath: string },
): FolderLyricsFile[] {
  return targets.flatMap((target) => {
    const path = target.kind === "local" ? pathBelowFolder(folder.rootPath, target.path) : null;
    if (path === null || !isLyricsFilePath(path)) return [];
    return [
      { locationId: target.locationId, folderId: folder.id, path, title: fileName(path), sizeBytes: target.sizeBytes },
    ];
  });
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function fileName(path: string) {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

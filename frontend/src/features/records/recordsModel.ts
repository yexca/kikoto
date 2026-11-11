import type { RecordAsset, RecordFolder } from "@/lib/api";
import { naturalNameCompare } from "@/lib/naturalNameOrder";

import type { RecordCrumb, RecordKindFilter, RecordSortOrder } from "./recordsLocation";

/** What the grid shows for one folder: subfolders, then videos, then photos. */
export type RecordFolderView = {
  folders: RecordFolder[];
  videos: RecordAsset[];
  photos: RecordAsset[];
  /** Same-name WebVTT sidecars by video id. */
  subtitles: Map<number, RecordAsset>;
};

export function baseName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function playable(asset: RecordAsset) {
  return asset.availability === "available" && Boolean(asset.streamUrl);
}

function byName<T extends { name: string }>(sort: RecordSortOrder) {
  return (left: T, right: T) =>
    sort === "name-desc" ? naturalNameCompare(right.name, left.name) : naturalNameCompare(left.name, right.name);
}

/**
 * Splits a folder listing into what the grid shows. Subtitle, metadata, and
 * other files stay hidden; a WebVTT file whose base name matches a video
 * becomes that video's subtitle.
 */
export function recordFolderView(
  folders: readonly RecordFolder[],
  assets: readonly RecordAsset[],
  sort: RecordSortOrder,
): RecordFolderView {
  const videos = assets.filter((asset) => asset.kind === "video" && playable(asset)).sort(byName(sort));
  const photos = assets.filter((asset) => asset.kind === "image" && playable(asset)).sort(byName(sort));
  const vttByBase = new Map<string, RecordAsset>();
  for (const asset of assets) {
    if (asset.kind === "subtitle" && extension(asset.name) === "vtt") {
      vttByBase.set(baseName(asset.name).toLocaleLowerCase(), asset);
    }
  }
  const subtitles = new Map<number, RecordAsset>();
  for (const video of videos) {
    const match = vttByBase.get(baseName(video.name).toLocaleLowerCase());
    if (match) subtitles.set(video.id, match);
  }
  return { folders: [...folders].sort(byName(sort)), videos, photos, subtitles };
}

/** The sections the active filter shows; subfolders stay visible so the tree remains navigable. */
export function filteredRecordView(view: RecordFolderView, filter: RecordKindFilter): RecordFolderView {
  return {
    ...view,
    videos: filter === "photos" ? [] : view.videos,
    photos: filter === "videos" ? [] : view.photos,
  };
}

export function formatPlaybackTime(value: number) {
  const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = (total % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** The previous and next item around one id, in grid order. */
export function siblingIds(items: readonly { id: number }[], id: number) {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return { previous: null, next: null };
  return {
    previous: index > 0 ? items[index - 1].id : null,
    next: index < items.length - 1 ? items[index + 1].id : null,
  };
}

export function crumbFromFolder(folder: RecordFolder): RecordCrumb {
  const crumb: RecordCrumb = { id: folder.id, name: folder.name };
  if (folder.artwork.posterUrl) crumb.posterUrl = folder.artwork.posterUrl;
  if (folder.artwork.backdropUrl) crumb.backdropUrl = folder.artwork.backdropUrl;
  return crumb;
}

/**
 * The folder path a listing's children reveal, as names from the root. The
 * tree response does not describe the listed folder itself, so a pasted link
 * recovers its breadcrumb from a child's relative path; an empty folder has
 * no child to read it from.
 */
export function folderPathFromChildren(
  folders: readonly Pick<RecordFolder, "relativePath">[],
  assets: readonly Pick<RecordAsset, "relativePath">[],
): string[] | null {
  for (const child of [...folders, ...assets]) {
    const path = child.relativePath?.replace(/\\/g, "/");
    if (!path) continue;
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 1) return parts.slice(0, -1);
  }
  return null;
}

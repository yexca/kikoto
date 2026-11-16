import type { RecordAsset, RecordFolder } from "@/lib/api";
import { naturalNameCompare } from "@/lib/naturalNameOrder";

import type { RecordCrumb } from "./recordsLocation";

/** What a folder shows: subfolders, videos, and photos as tiles, then its other files as a list. */
export type RecordFolderView = {
  folders: RecordFolder[];
  videos: RecordAsset[];
  photos: RecordAsset[];
  /** Audio files the player plays, in list order. */
  audio: RecordAsset[];
  /** Every other file by name: audio, subtitles, metadata, and the rest. */
  files: RecordAsset[];
  /** Same-name subtitle sidecars the server serves as WebVTT, by video id. */
  subtitles: Map<number, RecordAsset>;
};

/** Kinds that show in a folder's file list rather than as tiles. */
const listedFileKinds = new Set<RecordAsset["kind"]>(["audio", "subtitle", "metadata", "other"]);

/** Image names the server reads as folder artwork; they never show as photos. */
const artworkStems = new Set(["folder", "poster", "cover", "backdrop", "fanart", "background"]);

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

function byName<T extends { name: string }>(left: T, right: T) {
  return naturalNameCompare(left.name, right.name);
}

export function isFolderArtwork(asset: Pick<RecordAsset, "kind" | "name">) {
  return asset.kind === "image" && artworkStems.has(baseName(asset.name).toLocaleLowerCase());
}

/**
 * Splits a folder listing into what the folder shows. Videos and photos are
 * tiles; audio, subtitle, metadata, and other files are listed as files; the
 * folder's artwork images stay hidden. A WebVTT or SubRip file whose base name
 * matches a video becomes that video's subtitle, WebVTT first, when the server
 * serves it, and stays in the file list.
 */
export function recordFolderView(folders: readonly RecordFolder[], assets: readonly RecordAsset[]): RecordFolderView {
  const videos = assets.filter((asset) => asset.kind === "video" && playable(asset)).sort(byName);
  const photos = assets
    .filter((asset) => asset.kind === "image" && playable(asset) && !isFolderArtwork(asset))
    .sort(byName);
  const vttByBase = new Map<string, RecordAsset>();
  for (const asset of assets) {
    const ext = extension(asset.name);
    if (asset.kind !== "subtitle" || !asset.streamUrl || (ext !== "vtt" && ext !== "srt")) continue;
    const key = baseName(asset.name).toLocaleLowerCase();
    const known = vttByBase.get(key);
    if (!known || (ext === "vtt" && extension(known.name) !== "vtt")) vttByBase.set(key, asset);
  }
  const subtitles = new Map<number, RecordAsset>();
  for (const video of videos) {
    const match = vttByBase.get(baseName(video.name).toLocaleLowerCase());
    if (match) subtitles.set(video.id, match);
  }
  const audio = assets.filter((asset) => asset.kind === "audio" && playable(asset)).sort(byName);
  const files = assets
    .filter((asset) => asset.availability === "available" && listedFileKinds.has(asset.kind))
    .sort(byName);
  return { folders: [...folders].sort(byName), videos, photos, audio, files, subtitles };
}

/** A file size in binary units, one decimal below 10. */
export function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/** The upper-case extension a file list shows as the file's type. */
export function fileTypeLabel(name: string) {
  return extension(name).toUpperCase();
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

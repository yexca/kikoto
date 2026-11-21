import type { RecordFolder } from "@/lib/api";

import type { RecordCrumb } from "./recordsLocation";

export function baseName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
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

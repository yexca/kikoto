import type { TFunction } from "i18next";

import type { Work } from "@/lib/api";

export function recentProgressLabel(progress: Work["progress"], t: TFunction) {
  const track = recentTrackName(progress) || t("library.track");
  if (progress.completed) return `${t("library.finished")} · ${track}`;
  const duration =
    progress.durationSeconds && progress.durationSeconds > 0
      ? ` / ${formatPlaybackTime(progress.durationSeconds)}`
      : "";
  return `${track} · ${formatPlaybackTime(progress.positionSeconds)}${duration}`;
}

// Saved titles keep the folder path the track was played from; the last
// segment is the part a listener recognizes.
export function recentTrackName(progress: Work["progress"]) {
  const segments = (progress.title || "").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export function formatPlaybackTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = String(safeSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainingSeconds}`
    : `${minutes}:${remainingSeconds}`;
}

export function progressPercent(progress: Work["progress"]) {
  if (progress.completed) return 100;
  if (!progress.durationSeconds || progress.durationSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.positionSeconds / progress.durationSeconds) * 100));
}

import type { MediaProgress } from "../lib/api";

export const REMOTE_PROGRESS_INTERVAL_MS = 30_000;
export const LOCAL_PROGRESS_INTERVAL_MS = 1_000;

export type ProgressSaveMarker = {
  mediaItemId: number;
  position: number;
  completed: boolean;
  at: number;
};

export type LocalProgressCheckpoint = {
  mediaItemId: number;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  updatedAt: string;
};

export function shouldSaveRemoteProgress(
  previous: ProgressSaveMarker | null,
  current: ProgressSaveMarker,
  force: boolean,
) {
  if (!previous || previous.mediaItemId !== current.mediaItemId) return true;
  const elapsed = current.at - previous.at;
  const positionDelta = Math.abs(current.position - previous.position);
  if (elapsed < LOCAL_PROGRESS_INTERVAL_MS && positionDelta < 0.5 && previous.completed === current.completed) {
    return false;
  }
  return force || elapsed >= REMOTE_PROGRESS_INTERVAL_MS;
}

export function shouldSaveLocalProgress(
  previous: ProgressSaveMarker | null,
  current: ProgressSaveMarker,
  force: boolean,
) {
  if (force || !previous || previous.mediaItemId !== current.mediaItemId) return true;
  return (
    current.at - previous.at >= LOCAL_PROGRESS_INTERVAL_MS ||
    Math.abs(current.position - previous.position) >= 5 ||
    current.completed !== previous.completed
  );
}

export function checkpointProgress(checkpoint: LocalProgressCheckpoint): MediaProgress {
  return {
    positionSeconds: checkpoint.positionSeconds,
    durationSeconds: checkpoint.durationSeconds,
    completed: checkpoint.completed,
    lastPlayedAt: checkpoint.updatedAt,
  };
}

export function newestMediaProgress(first: MediaProgress | null, second: MediaProgress | null): MediaProgress | null {
  if (!first) return second;
  if (!second) return first;
  return progressTimestamp(second.lastPlayedAt) > progressTimestamp(first.lastPlayedAt) ? second : first;
}

function progressTimestamp(value: string | null) {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

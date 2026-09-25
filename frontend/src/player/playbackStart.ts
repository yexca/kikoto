import type { MediaProgress } from "@/lib/api";

export function normalizePlaybackStartPosition(positionSeconds?: number) {
  return positionSeconds !== undefined && Number.isFinite(positionSeconds) && positionSeconds > 0 ? positionSeconds : 0;
}

// A restored queue continues the Resume cursor only while that cursor is unfinished.
export function restoredCursorStartPosition(progress: MediaProgress | null | undefined) {
  return progress && !progress.completed ? normalizePlaybackStartPosition(progress.positionSeconds) : 0;
}

// A playback instance may replace the Resume cursor only after its start
// position is applied and the listener has played or sought within it.
export function canPersistPlaybackProgress(
  currentPlaybackInstanceKey: string | null,
  startAppliedInstanceKey: string | null,
  listenerIntentInstanceKey: string | null,
) {
  return (
    currentPlaybackInstanceKey !== null &&
    startAppliedInstanceKey === currentPlaybackInstanceKey &&
    listenerIntentInstanceKey === currentPlaybackInstanceKey
  );
}

export function shouldCheckpointPause(
  completedPlaybackInstanceKey: string | null,
  currentPlaybackInstanceKey: string | null,
) {
  return completedPlaybackInstanceKey === null || completedPlaybackInstanceKey !== currentPlaybackInstanceKey;
}

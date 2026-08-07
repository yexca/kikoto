export const REMOTE_PROGRESS_INTERVAL_MS = 30_000;
const FORCED_PROGRESS_DEDUP_INTERVAL_MS = 1_000;

export type ProgressSaveMarker = {
  mediaItemId: number;
  position: number;
  completed: boolean;
  at: number;
};

export function shouldSaveRemoteProgress(
  previous: ProgressSaveMarker | null,
  current: ProgressSaveMarker,
  force: boolean,
) {
  if (!previous || previous.mediaItemId !== current.mediaItemId) return true;
  const elapsed = current.at - previous.at;
  const positionDelta = Math.abs(current.position - previous.position);
  if (elapsed < FORCED_PROGRESS_DEDUP_INTERVAL_MS && positionDelta < 0.5 && previous.completed === current.completed) {
    return false;
  }
  return force || elapsed >= REMOTE_PROGRESS_INTERVAL_MS;
}

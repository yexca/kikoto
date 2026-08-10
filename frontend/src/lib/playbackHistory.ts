import type { WorkProgressSummary } from "./api";

export function hasPlaybackHistory(
  progress: Pick<WorkProgressSummary, "mediaItemId" | "lastPlayedAt"> | null | undefined,
) {
  return Boolean(progress?.mediaItemId && progress.lastPlayedAt);
}

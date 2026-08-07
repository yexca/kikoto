import type { MediaProgressUpdate, WorkProgressSummary } from "@/lib/api";

export function cursorUpdateAffectsWork(
  requestedWorkId: number,
  currentCursor: WorkProgressSummary | null,
  update: MediaProgressUpdate,
) {
  return (
    update.workId === requestedWorkId ||
    update.mediaWorkId === requestedWorkId ||
    currentCursor?.workId === update.workId
  );
}

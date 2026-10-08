import type { PlaybackReport, PlaybackReportResult } from "../../../src/lib/playbackReportApi";

export function playbackReportResultFixture(report: PlaybackReport, generation = 0): PlaybackReportResult {
  return {
    generation,
    history: report.history.map((r) => ({
      sessionId: r.sessionId,
      status: r.generation === generation ? "recorded" : "history_cleared",
    })),
    progress: report.progress.map((r) => ({
      reportId: r.reportId,
      status: "recorded",
      cursor: {
        workId: 1,
        mediaWorkId: 1,
        mediaItemId: r.mediaItemId,
        fileSourceId: 1,
        locationId: r.locationId,
        locationType: "local",
        positionSeconds: r.positionSeconds,
        durationSeconds: r.durationSeconds,
        completed: r.completed,
        lastPlayedAt: "2026-01-01 00:00:00",
      },
    })),
  };
}

import type { Page } from "@playwright/test";
import type { PlaybackReport, PlaybackReportResult } from "../../../src/lib/playbackReportApi";
import type { ReportOutboxState } from "../../../src/player/playbackReportOutbox";

export async function readPlaybackReportOutbox(page: Page, accountId = 1) {
  return page.evaluate(async (id) => {
    if (!(await indexedDB.databases()).some((db) => db.name === "kikoto-playback-reports")) return undefined;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("kikoto-playback-reports", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<ReportOutboxState | undefined>((resolve, reject) => {
        const tx = db.transaction("outbox");
        const request = tx.objectStore("outbox").get(`${encodeURIComponent(location.origin)}:user-${id}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, accountId);
}

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

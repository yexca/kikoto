import { apiTransport, type MediaProgressUpdate } from "./api";
import { combineAbortSignals } from "./inflightRequests";
import { LISTENING_REPORT_TIMEOUT_MS, type ListeningSessionReport } from "./listeningApi";

export type DatedListeningReport = ListeningSessionReport & {
  startedAt: string;
  lastListenedAt: string;
  days: { day: string; listenedSeconds: number }[];
};

export type ProgressReport = {
  reportId: string;
  order: number;
  mediaItemId: number;
  locationId: number;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
};

export type PlaybackReport = { history: DatedListeningReport[]; progress: ProgressReport[] };
export type ReportStatus = "recorded" | "stale" | "history_cleared" | "invalid" | "not_found" | "conflict";
export type PlaybackReportResult = {
  generation: number;
  history: { sessionId: string; status: ReportStatus }[];
  progress: { reportId: string; status: ReportStatus; cursor?: MediaProgressUpdate }[];
};

export async function sendPlaybackReport(report: PlaybackReport, signal: AbortSignal, keepalive = false) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), LISTENING_REPORT_TIMEOUT_MS);
  const cancellation = combineAbortSignals(signal, timeout.signal);
  try {
    return await apiTransport.sendJSONBody<PlaybackReportResult>("POST", "/api/playback-reports", report, {
      signal: cancellation.signal,
      keepalive,
    });
  } finally {
    clearTimeout(timer);
    cancellation.dispose();
  }
}

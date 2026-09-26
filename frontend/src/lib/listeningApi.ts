import { apiTransport } from "@/lib/api";

/** One track play activation's cumulative wall-clock listening time. */
export type ListeningSessionReport = {
  /**
   * The account's history generation when the interval began. Clearing history
   * increments it, and the server rejects a report for an older generation.
   */
  generation: number;
  sessionId: string;
  workId: number;
  listenedSeconds: number;
};

export type ListeningHistoryItem = {
  workId: number;
  primaryCode: string;
  title: string;
  listenedSeconds: number;
  listenCount: number;
  lastPlayedAt: string;
};

export type ListeningHistoryPage = {
  items: ListeningHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type ListeningDailyStatistic = {
  /** UTC calendar date, YYYY-MM-DD. */
  date: string;
  listenedSeconds: number;
  listenCount: number;
};

export type ListeningStatistics = {
  listenedSeconds: number;
  listenCount: number;
  workCount: number;
  activeDays: number;
  daily: ListeningDailyStatistic[];
  topWorks: ListeningHistoryItem[];
};

/** The server's error code for a report whose generation predates a history clear. */
export const LISTENING_HISTORY_CLEARED_CODE = "listening_history_cleared";

/** A listening request that has not completed by then is abandoned and retried later. */
export const LISTENING_REPORT_TIMEOUT_MS = 20_000;

function timeoutSignal(ms: number) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("The listening request timed out.", "TimeoutError")), ms);
  return controller.signal;
}

/** The server keeps the maximum reported total per session, so a retry is idempotent. */
export const listeningApi = {
  /** The generation new listening sessions must report under. */
  generation: () =>
    apiTransport.getJSON<{ generation: number }>("/api/listening-sessions", timeoutSignal(LISTENING_REPORT_TIMEOUT_MS)),
  reportSession: (report: ListeningSessionReport, options: { keepalive?: boolean } = {}) =>
    apiTransport.sendJSONBody<unknown>("POST", "/api/listening-sessions", report, {
      keepalive: options.keepalive,
      signal: timeoutSignal(LISTENING_REPORT_TIMEOUT_MS),
    }),
  history: (options: { page: number; pageSize: number; query?: string }, signal?: AbortSignal) => {
    const search = new URLSearchParams({ page: String(options.page), pageSize: String(options.pageSize) });
    const query = options.query?.trim();
    if (query) search.set("q", query);
    return apiTransport.getJSON<ListeningHistoryPage>(`/api/listening-history?${search}`, signal);
  },
  statistics: (signal?: AbortSignal) => apiTransport.getJSON<ListeningStatistics>("/api/listening-statistics", signal),
  clearHistory: () => apiTransport.deleteJSON<unknown>("/api/listening-history"),
};

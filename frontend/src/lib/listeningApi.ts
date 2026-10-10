import { apiTransport } from "@/lib/apiTransport";

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
  /** Cached cover, or empty when none is cached. */
  coverUrl: string;
};

export type ListeningHistoryPage = {
  items: ListeningHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type ListeningStatisticsRange = "30d" | "12m" | "all";

export type ListeningGranularity = "day" | "month" | "year";

export type ListeningPeriodStatistic = {
  /** UTC period: YYYY-MM-DD for a day, YYYY-MM for a month, or YYYY for a year. */
  period: string;
  listenedSeconds: number;
  listenCount: number;
};

/**
 * One range of the listening report. Bounded ranges count only dated
 * listening; all time also includes imported totals, which have no dates.
 */
export type ListeningStatistics = {
  range: ListeningStatisticsRange;
  listenedSeconds: number;
  listenCount: number;
  workCount: number;
  activeDays: number;
  granularity: ListeningGranularity;
  /** Every period of the range, oldest first; periods without listening are zero. */
  series: ListeningPeriodStatistic[];
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
  statistics: (range: ListeningStatisticsRange, signal?: AbortSignal) =>
    apiTransport.getJSON<ListeningStatistics>(`/api/listening-statistics?range=${range}`, signal),
  clearHistory: () => apiTransport.deleteJSON<unknown>("/api/listening-history"),
};

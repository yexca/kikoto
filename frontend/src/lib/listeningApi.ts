import { apiTransport } from "@/lib/apiTransport";
import { deviceTimeZone } from "@/lib/timeZone";

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

/** A report range that ends today. */
export type ListeningNamedRange = "30d" | "12m" | "all";

/** A named range, or a calendar year such as "2026". */
export type ListeningStatisticsRange = ListeningNamedRange | `${number}`;

export type ListeningGranularity = "day" | "month" | "year";

export type ListeningPeriodStatistic = {
  /** A period of the account's calendar: YYYY-MM-DD for a day, YYYY-MM for a month, or YYYY for a year. */
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
  /** The calendar day the report ends on, in the account's time zone. */
  today?: string;
  /** Every period of the range, oldest first; periods without listening are zero. */
  series: ListeningPeriodStatistic[];
  topWorks: ListeningHistoryItem[];
  /** The calendar years with dated listening, latest first. */
  years?: string[];
  /** Listening per hour of the day, midnight first, for the listening whose hours were recorded. */
  hours?: number[];
  /** The standout figures of a calendar year; other ranges have none. */
  highlights?: ListeningHighlights;
};

export type ListeningHighlights = {
  /** The day with the most listening and the work listened to most on it. */
  busiestDay?: { date: string; listenedSeconds: number; topWork?: ListeningHistoryItem };
  /** Works whose first dated listening falls in the year. */
  newWorkCount: number;
  topVoice?: ListeningBreakdownEntry;
  topCircle?: ListeningBreakdownEntry;
};

export type ListeningCalendarDay = {
  /** A calendar day of the account's time zone, YYYY-MM-DD. */
  date: string;
  listenedSeconds: number;
  listenCount: number;
};

/** Dated listening for the 52 weeks before the current week through today, or for one calendar year. */
export type ListeningCalendar = {
  /** The Monday the calendar starts on, or the first day of its year. */
  from: string;
  to: string;
  /** The IANA zone whose calendar the days follow. */
  timeZone?: string;
  /** Whether that zone is this device's because the account fixed none. */
  followsDevice?: boolean;
  /** Sparse and oldest first; a day without listening is absent. */
  days: ListeningCalendarDay[];
};

export type ListeningBreakdownKind = "tags" | "voices" | "circles";

/**
 * How a breakdown orders its entries: by listening time, or by how far an
 * entry's share of listening time exceeds its share of the library's works.
 */
export type ListeningBreakdownRank = "preference" | "time";

/** The listening of every work that carries one tag, credits one voice, or belongs to one circle. */
export type ListeningBreakdownEntry = {
  id: number;
  name: string;
  /** A circle's provider id; absent when it has none. */
  externalId?: string;
  /** A voice's detail route key. */
  routeKey?: string;
  listenedSeconds: number;
  listenCount: number;
  workCount: number;
  /** How many of the library's works the entry covers; present in a preference ranking. */
  libraryWorkCount?: number;
};

/**
 * One range ranked by tag, voice, and circle, with the scope of the listening
 * report. A work counts in full toward each of its tags and voices, so a
 * dimension's entries do not add up to the total.
 */
export type ListeningBreakdown = Record<ListeningBreakdownKind, ListeningBreakdownEntry[]> & {
  range: ListeningStatisticsRange;
  rank: ListeningBreakdownRank;
  listenedSeconds: number;
  /** The number of works the library lists; present in a preference ranking. */
  libraryWorkCount?: number;
};

/** Where an account's listening sits on one work attribute, against the library. */
export type ListeningProfileTrait = {
  /** The attribute's listening-time-weighted mean over the listened works. */
  value: number;
  /** The attribute's mean over the works it is compared with. */
  libraryValue: number;
  /** From 0 to 1; 0.5 is where the comparison sits. */
  position: number;
  workCount: number;
};

/**
 * What an account listens to in one range, against the library: its most
 * preferred tags, and where its works sit by duration (seconds), release
 * (calendar years), and popularity (sales). `rating` compares the account's
 * ratings with the public ones.
 */
export type ListeningProfile = {
  range: ListeningStatisticsRange;
  listenedSeconds: number;
  workCount: number;
  libraryWorkCount: number;
  tags: ListeningBreakdownEntry[];
  duration?: ListeningProfileTrait;
  release?: ListeningProfileTrait;
  popularity?: ListeningProfileTrait;
  rating?: ListeningProfileTrait;
  /** The listened works the account marked as started. */
  marks: { works: number; finished: number; relisten: number };
};

/** The server's error code for a report whose generation predates a history clear. */
export const LISTENING_HISTORY_CLEARED_CODE = "listening_history_cleared";

/** A listening request that has not completed by then is abandoned and retried later. */
export const LISTENING_REPORT_TIMEOUT_MS = 20_000;

/**
 * A report's query with this device's time zone, which decides where the
 * report's days start for an account that fixed no zone of its own.
 */
function reportQuery(values: Record<string, string> = {}) {
  const search = new URLSearchParams(values);
  const zone = deviceTimeZone();
  if (zone) search.set("timeZone", zone);
  const query = search.toString();
  return query ? `?${query}` : "";
}

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
    apiTransport.getJSON<ListeningStatistics>(`/api/listening-statistics${reportQuery({ range })}`, signal),
  /** The calendar of a year, or of the weeks up to today for a range that names none. */
  calendar: (year: string | null, signal?: AbortSignal) =>
    apiTransport.getJSON<ListeningCalendar>(
      `/api/listening-calendar${reportQuery(year ? { range: year } : {})}`,
      signal,
    ),
  profile: (range: ListeningStatisticsRange, signal?: AbortSignal) =>
    apiTransport.getJSON<ListeningProfile>(`/api/listening-profile${reportQuery({ range })}`, signal),
  breakdown: (range: ListeningStatisticsRange, rank: ListeningBreakdownRank, signal?: AbortSignal) =>
    apiTransport.getJSON<ListeningBreakdown>(`/api/listening-breakdown${reportQuery({ range, rank })}`, signal),
  clearHistory: () => apiTransport.deleteJSON<unknown>("/api/listening-history"),
};

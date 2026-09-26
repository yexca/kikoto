import type { ListeningDailyStatistic } from "@/lib/listeningApi";

export const LISTENING_HISTORY_PAGE_SIZE = 30;
export const LISTENING_DAILY_DAYS = 30;

export type ListeningDurationParts =
  | { key: "hoursMinutes"; values: { hours: number; minutes: number } }
  | { key: "minutes"; values: { minutes: number } }
  | { key: "seconds"; values: { seconds: number } };

/** Whole hours and minutes for totals; seconds only below one minute. */
export function listeningDurationParts(totalSeconds: number): ListeningDurationParts {
  const seconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  if (seconds < 60) return { key: "seconds", values: { seconds } };
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return { key: "minutes", values: { minutes: totalMinutes } };
  return { key: "hoursMinutes", values: { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 } };
}

function utcDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The last 30 UTC calendar days ending today, oldest first. Days the server
 * omits are listening-free days, not missing data, so they render as zero.
 */
export function dailyListeningSeries(daily: readonly ListeningDailyStatistic[], now = new Date()) {
  const byDate = new Map(daily.map((entry) => [entry.date, entry]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: LISTENING_DAILY_DAYS }, (_, index) => {
    const date = utcDateKey(new Date(today - (LISTENING_DAILY_DAYS - 1 - index) * 86_400_000));
    const entry = byDate.get(date);
    return {
      date,
      listenedSeconds: Math.max(0, entry?.listenedSeconds ?? 0),
      listenCount: Math.max(0, entry?.listenCount ?? 0),
    };
  });
}

/** Bar height as a share of the busiest day; a listened day never renders invisible. */
export function dailyBarPercent(listenedSeconds: number, maxSeconds: number) {
  if (listenedSeconds <= 0 || maxSeconds <= 0) return 0;
  return Math.max(4, Math.round((listenedSeconds / maxSeconds) * 100));
}

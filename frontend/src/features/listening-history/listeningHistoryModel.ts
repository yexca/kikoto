import type { ListeningPeriodStatistic, ListeningStatisticsRange } from "@/lib/listeningApi";

export const LISTENING_HISTORY_PAGE_SIZE = 30;

/** Report ranges in switcher order; the first is the default. */
export const LISTENING_REPORT_RANGES: readonly ListeningStatisticsRange[] = ["30d", "12m", "all"];

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

/** The UTC start of a series period: YYYY, YYYY-MM, or YYYY-MM-DD. */
export function periodStart(period: string) {
  const [year, month = "01", day = "01"] = period.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

/** Bar length as a share of the largest value; a nonzero value never renders invisible. */
export function barPercent(value: number, maxValue: number) {
  if (value <= 0 || maxValue <= 0) return 0;
  return Math.max(4, Math.round((value / maxValue) * 100));
}

/**
 * Totals for the charted periods: periods with listening, their mean, and the
 * busiest period (the latest one on a tie).
 */
export function listeningPeriodInsights(series: readonly ListeningPeriodStatistic[]) {
  const listened = series.filter((entry) => entry.listenedSeconds > 0);
  const totalSeconds = listened.reduce((sum, entry) => sum + entry.listenedSeconds, 0);
  const peak = listened.reduce<ListeningPeriodStatistic | null>(
    (best, entry) => (best === null || entry.listenedSeconds >= best.listenedSeconds ? entry : best),
    null,
  );
  return {
    totalSeconds,
    activePeriods: listened.length,
    averageSeconds: listened.length > 0 ? Math.round(totalSeconds / listened.length) : 0,
    peak,
  };
}

/**
 * Runs of consecutive periods with listening: the longest, and the current
 * one ending at the latest period. While the latest period has no listening
 * yet, the current run ends at the period before it.
 */
export function listeningStreaks(series: readonly ListeningPeriodStatistic[]) {
  let longest = 0;
  let run = 0;
  for (const entry of series) {
    run = entry.listenedSeconds > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let end = series.length - 1;
  if (end >= 0 && series[end].listenedSeconds <= 0) end -= 1;
  let current = 0;
  for (let index = end; index >= 0 && series[index].listenedSeconds > 0; index -= 1) current += 1;
  return { current, longest };
}

/**
 * Mean listening per weekday of a daily series, Monday first. Each weekday
 * averages over all of its days in the range, including days without listening.
 */
export function weekdayAverages(series: readonly ListeningPeriodStatistic[]) {
  const totals = Array.from({ length: 7 }, () => ({ seconds: 0, days: 0 }));
  for (const entry of series) {
    const total = totals[(periodStart(entry.period).getUTCDay() + 6) % 7];
    total.seconds += entry.listenedSeconds;
    total.days += 1;
  }
  return totals.map((total, weekday) => ({
    weekday,
    averageSeconds: total.days > 0 ? Math.round(total.seconds / total.days) : 0,
  }));
}

/** UTC calendar days a report covers, from its first period's start through today. */
export function reportDayCount(series: readonly ListeningPeriodStatistic[], now = new Date()) {
  const first = series[0];
  if (!first) return 0;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(1, Math.round((today - periodStart(first.period).getTime()) / 86_400_000) + 1);
}

/** A part of a total as a whole percent; a nonzero part never rounds down to zero. */
export function sharePercent(value: number, total: number) {
  if (value <= 0 || total <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round((value / total) * 100)));
}

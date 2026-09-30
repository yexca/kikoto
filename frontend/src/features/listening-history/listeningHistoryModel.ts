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

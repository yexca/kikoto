import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { dateTimeFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ListeningGranularity, ListeningPeriodStatistic } from "@/lib/listeningApi";
import { cn } from "@/lib/tailwindClassNames";

import { barPercent, listeningStreaks, sharePercent, weekdayAverages } from "./listeningHistoryModel";

// 2024-01-01 is a Monday, so offsets from it name the weekdays in Monday-first order.
const mondayUTC = Date.UTC(2024, 0, 1);

/**
 * Listening regularity for a report: current and longest runs of periods with
 * listening, then the average per weekday for a daily report or the share of
 * periods with listening for a monthly or yearly one.
 */
export function ListeningRhythm({
  series,
  granularity,
  formatDuration,
}: {
  series: readonly ListeningPeriodStatistic[];
  granularity: ListeningGranularity;
  formatDuration: (seconds: number) => string;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const streaks = useMemo(() => listeningStreaks(series), [series]);
  const weekdays = useMemo(() => (granularity === "day" ? weekdayAverages(series) : []), [granularity, series]);
  const activePeriods = series.filter((entry) => entry.listenedSeconds > 0).length;
  const activeShare = sharePercent(activePeriods, series.length);
  const weekdayMax = Math.max(0, ...weekdays.map((entry) => entry.averageSeconds));
  const weekdayName = (weekday: number) =>
    dateTimeFormat(resolvedLocale, { weekday: "short", timeZone: "UTC" }).format(mondayUTC + weekday * 86_400_000);

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-2">
        <RhythmFigure
          label={t("personal.history.currentStreak")}
          value={t(`personal.history.periodCount.${granularity}`, { count: streaks.current })}
        />
        <RhythmFigure
          label={t("personal.history.longestStreak")}
          value={t(`personal.history.periodCount.${granularity}`, { count: streaks.longest })}
        />
      </dl>
      {granularity === "day" ? (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">{t("personal.history.weekdayAverage")}</h4>
          <dl className="space-y-1">
            {weekdays.map((entry) => {
              const busiest = weekdayMax > 0 && entry.averageSeconds === weekdayMax;
              return (
                <div key={entry.weekday} className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-2">
                  <dt className="truncate text-xs text-muted-foreground">{weekdayName(entry.weekday)}</dt>
                  <dd className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span
                      className={cn("block h-full rounded-full", busiest ? "bg-primary" : "bg-primary/45")}
                      style={{ width: `${barPercent(entry.averageSeconds, weekdayMax)}%` }}
                    />
                  </dd>
                  <dd
                    className={cn(
                      "min-w-14 text-right text-2xs tabular-nums",
                      busiest ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {entry.averageSeconds > 0 ? formatDuration(entry.averageSeconds) : "–"}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-muted-foreground">{t(`personal.history.activePeriods.${granularity}`)}</span>
            <span className="tabular-nums">
              {t("personal.history.activePeriodsValue", { active: activePeriods, total: series.length })}
            </span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-primary/15"
            role="meter"
            aria-label={t(`personal.history.activePeriods.${granularity}`)}
            aria-valuemin={0}
            aria-valuemax={series.length}
            aria-valuenow={activePeriods}
          >
            <span className="block h-full rounded-full bg-primary" style={{ width: `${activeShare}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

function RhythmFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2">
      <dt className="truncate text-2xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-base font-semibold">{value}</dd>
    </div>
  );
}

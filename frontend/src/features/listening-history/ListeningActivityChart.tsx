import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { dateTimeFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ListeningGranularity, ListeningPeriodStatistic } from "@/lib/listeningApi";
import { cn } from "@/lib/tailwindClassNames";

import { barPercent, listeningPeriodInsights, periodStart } from "./listeningHistoryModel";

const periodLabelOptions: Record<ListeningGranularity, Intl.DateTimeFormatOptions> = {
  day: { month: "short", day: "numeric", timeZone: "UTC" },
  month: { year: "numeric", month: "short", timeZone: "UTC" },
  year: { year: "numeric", timeZone: "UTC" },
};

/**
 * One series of listening time per day, month, or year: single-hue bars on a
 * recessive baseline with the busiest-period scale and the average of listened
 * periods as reference lines, a readout for the pointed period, and period
 * insights. The same values stay available to assistive technology as a table.
 */
export function ListeningActivityChart({
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
  const insights = useMemo(() => listeningPeriodInsights(series), [series]);
  const maxSeconds = insights.peak?.listenedSeconds ?? 0;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const periodLabel = (period: string) =>
    dateTimeFormat(resolvedLocale, periodLabelOptions[granularity]).format(periodStart(period));
  const active = activeIndex === null ? null : series[activeIndex];
  const averagePercent = maxSeconds > 0 ? (insights.averageSeconds / maxSeconds) * 100 : 0;
  const first = series[0];
  const last = series[series.length - 1];

  return (
    <figure className="min-w-0 space-y-3">
      <figcaption className="flex min-h-5 flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t(`personal.history.chartTitle.${granularity}`)}</span>
        <span aria-live="polite" className="tabular-nums">
          {active
            ? t("personal.history.periodReadout", {
                period: periodLabel(active.period),
                duration: formatDuration(active.listenedSeconds),
                count: active.listenCount,
              })
            : t("personal.history.periodHint")}
        </span>
      </figcaption>
      <div className="space-y-1 pt-4">
        <div className="relative h-40">
          {maxSeconds > 0 && (
            <div aria-hidden="true">
              <div className="absolute inset-x-0 top-0 border-t border-border/70" />
              <span className="absolute left-0 top-0 -translate-y-full pb-0.5 text-2xs tabular-nums text-muted-foreground">
                {formatDuration(maxSeconds)}
              </span>
              {averagePercent < 88 && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-foreground/35"
                  style={{ bottom: `${averagePercent}%` }}
                >
                  <span className="absolute right-0 top-0 -translate-y-full rounded-sm bg-card/90 px-1 pb-0.5 text-2xs tabular-nums text-muted-foreground">
                    {t("personal.history.averageLine", { duration: formatDuration(insights.averageSeconds) })}
                  </span>
                </div>
              )}
            </div>
          )}
          {maxSeconds === 0 && (
            <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
              {t("personal.history.noListeningInPeriod")}
            </p>
          )}
          <div
            aria-hidden="true"
            className={cn(
              "absolute inset-0 flex items-end border-b border-border/80",
              series.length > 16 ? "gap-0.5" : "gap-1.5",
            )}
            onPointerLeave={() => setActiveIndex(null)}
          >
            {series.map((entry, index) => (
              <div
                key={entry.period}
                className="flex h-full min-w-0 flex-1 items-end justify-center rounded-t hover:bg-muted/40"
                onPointerEnter={() => setActiveIndex(index)}
              >
                <div
                  className={cn(
                    "w-full max-w-6 rounded-t bg-primary/70 transition-colors",
                    activeIndex === index && "bg-primary",
                  )}
                  style={{ height: `${barPercent(entry.listenedSeconds, maxSeconds)}%` }}
                />
              </div>
            ))}
          </div>
        </div>
        {first && last && (
          <div className="flex justify-between text-2xs tabular-nums text-muted-foreground" aria-hidden="true">
            <span>{periodLabel(first.period)}</span>
            {last !== first && <span>{periodLabel(last.period)}</span>}
          </div>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-2">
        <PeriodInsight
          label={t(`personal.history.average.${granularity}`)}
          value={insights.activePeriods > 0 ? formatDuration(insights.averageSeconds) : "–"}
        />
        <PeriodInsight
          label={t(`personal.history.busiest.${granularity}`)}
          value={
            insights.peak
              ? t("personal.history.busiestValue", {
                  period: periodLabel(insights.peak.period),
                  duration: formatDuration(insights.peak.listenedSeconds),
                })
              : "–"
          }
        />
      </dl>
      {/* A table ignores the clipped height, so the wrapper keeps it from adding scroll space. */}
      <div className="sr-only">
        <table>
          <caption>{t(`personal.history.chartTitle.${granularity}`)}</caption>
          <thead>
            <tr>
              <th scope="col">{t("personal.history.period")}</th>
              <th scope="col">{t("personal.history.totalTime")}</th>
              <th scope="col">{t("personal.history.plays")}</th>
            </tr>
          </thead>
          <tbody>
            {series
              .slice()
              .reverse()
              .map((entry) => (
                <tr key={entry.period}>
                  <td>{periodLabel(entry.period)}</td>
                  <td>{formatDuration(entry.listenedSeconds)}</td>
                  <td>{entry.listenCount}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function PeriodInsight({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2">
      <dt className="truncate text-2xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

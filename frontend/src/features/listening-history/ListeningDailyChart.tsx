import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { dateTimeFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ListeningDailyStatistic } from "@/lib/listeningApi";
import { cn } from "@/lib/tailwindClassNames";

import { dailyBarPercent, dailyListeningSeries } from "./listeningHistoryModel";

/**
 * One series of daily listening time: single-hue bars on a recessive baseline,
 * a readout for the pointed day, and the same values as a table.
 */
export function ListeningDailyChart({
  daily,
  formatDuration,
}: {
  daily: readonly ListeningDailyStatistic[];
  formatDuration: (seconds: number) => string;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const series = useMemo(() => dailyListeningSeries(daily), [daily]);
  const maxSeconds = Math.max(0, ...series.map((day) => day.listenedSeconds));
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const dayLabel = (date: string) =>
    dateTimeFormat(resolvedLocale, { month: "short", day: "numeric", timeZone: "UTC" }).format(
      new Date(`${date}T00:00:00Z`),
    );
  const active = activeIndex === null ? null : series[activeIndex];

  return (
    <figure className="min-w-0 space-y-2">
      <figcaption className="flex min-h-5 flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t("personal.history.last30Days")}</span>
        <span aria-live="polite" className="tabular-nums">
          {active
            ? t("personal.history.dailyReadout", {
                date: dayLabel(active.date),
                duration: formatDuration(active.listenedSeconds),
                count: active.listenCount,
              })
            : t("personal.history.dailyHint")}
        </span>
      </figcaption>
      <div
        role="img"
        aria-label={t("personal.history.dailyChart")}
        className="flex h-32 items-end gap-0.5 border-b border-border/80"
        onPointerLeave={() => setActiveIndex(null)}
      >
        {series.map((day, index) => (
          <div
            key={day.date}
            aria-hidden="true"
            className="flex h-full min-w-0 flex-1 items-end"
            onPointerEnter={() => setActiveIndex(index)}
          >
            <div
              className={cn("w-full rounded-t bg-primary/70 transition-colors", activeIndex === index && "bg-primary")}
              style={{ height: `${dailyBarPercent(day.listenedSeconds, maxSeconds)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-2xs tabular-nums text-muted-foreground" aria-hidden="true">
        <span>{dayLabel(series[0].date)}</span>
        <span>{dayLabel(series[series.length - 1].date)}</span>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          {t("personal.history.showTable")}
        </summary>
        <div className="app-scrollbar mt-2 max-h-64 overflow-y-auto rounded-lg border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  {t("personal.history.date")}
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  {t("personal.history.totalTime")}
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  {t("personal.history.plays")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {series
                .slice()
                .reverse()
                .map((day) => (
                  <tr key={day.date}>
                    <td className="px-3 py-1.5">{dayLabel(day.date)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatDuration(day.listenedSeconds)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{day.listenCount}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

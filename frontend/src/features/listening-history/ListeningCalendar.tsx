import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { dateTimeFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ListeningCalendar as ListeningCalendarData } from "@/lib/listeningApi";
import { cn } from "@/lib/tailwindClassNames";

import {
  MONDAY_UTC,
  listeningCalendarWeeks,
  listeningStreaks,
  periodStart,
  type ListeningCalendarCell,
} from "./listeningHistoryModel";

// One hue in five steps: no listening, then the quartiles of the days with listening.
const levelClassNames = ["bg-muted", "bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"] as const;

// Weekday rows that carry a label, Monday first.
const labelledWeekdays = [0, 2, 4];

// A month label spans this many week columns, so it never widens the grid.
const MONTH_LABEL_WEEKS = 3;

/**
 * A year of listening as a calendar, the past year or one calendar year: one
 * cell per UTC day in week columns, shaded by listening time, with a readout
 * for the pointed day and the year's active days and streaks. A narrow container scrolls the weeks
 * and opens on the latest one.
 */
export function ListeningCalendar({
  calendar,
  year,
  formatDuration,
  action,
}: {
  calendar: ListeningCalendarData;
  /** The calendar year shown; null for the weeks up to today. */
  year?: string | null;
  formatDuration: (seconds: number) => string;
  /** The control that chooses the year, at the calendar's top end. */
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const { weeks, days } = useMemo(() => listeningCalendarWeeks(calendar), [calendar]);
  const streaks = useMemo(() => listeningStreaks(days), [days]);
  const [active, setActive] = useState<ListeningCalendarCell | null>(null);
  const titleId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [weeks.length]);

  const activeDays = days.filter((day) => day.listenedSeconds > 0).length;
  const totalSeconds = days.reduce((sum, day) => sum + day.listenedSeconds, 0);
  const dayLabel = (period: string) =>
    dateTimeFormat(resolvedLocale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(
      periodStart(period),
    );
  const monthLabel = (period: string) =>
    dateTimeFormat(resolvedLocale, { month: "short", timeZone: "UTC" }).format(periodStart(period));
  const weekdayName = (weekday: number) =>
    dateTimeFormat(resolvedLocale, { weekday: "short", timeZone: "UTC" }).format(MONDAY_UTC + weekday * 86_400_000);
  // A week is labelled when its Monday opens a new month; the first and last weeks only when the label has room.
  // A week belongs to the month of its first day in the calendar.
  const weekHeads = weeks.map((week) => week.find((day) => day !== null) ?? null);
  const monthStarts = weekHeads.map((head, index) => {
    return index > 0 && head?.period.slice(0, 7) !== weekHeads[index - 1]?.period.slice(0, 7);
  });
  const firstMonthStart = monthStarts.indexOf(true);
  if (firstMonthStart < 0 || firstMonthStart >= MONTH_LABEL_WEEKS) monthStarts[0] = true;
  const readout = !active
    ? t("personal.history.calendar.hint")
    : active.listenedSeconds > 0
      ? t("personal.history.periodReadout", {
          period: dayLabel(active.period),
          duration: formatDuration(active.listenedSeconds),
          count: active.listenCount,
        })
      : t("personal.history.calendar.noListening", { date: dayLabel(active.period) });

  return (
    <figure className="min-w-0 space-y-3" aria-labelledby={titleId}>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span id={titleId} className="text-sm font-semibold text-foreground">
            {t("personal.history.calendar.title")}
          </span>
          <span aria-live="polite" className="tabular-nums">
            {readout}
          </span>
        </div>
        {action}
      </div>
      <p className="sr-only">
        {t("personal.history.calendar.summary", { count: activeDays, duration: formatDuration(totalSeconds) })}
      </p>
      <div ref={scroller} className="overflow-x-auto pb-1" aria-hidden="true">
        <div
          className="grid min-w-[40rem] gap-[3px]"
          style={{ gridTemplateColumns: `auto repeat(${weeks.length}, minmax(0, 1fr))` }}
          onPointerLeave={() => setActive(null)}
        >
          {weekHeads.map(
            (head, index) =>
              monthStarts[index] &&
              head &&
              index + MONTH_LABEL_WEEKS <= weeks.length && (
                <span
                  key={head.period}
                  className="h-4 overflow-hidden whitespace-nowrap text-2xs leading-4 text-muted-foreground"
                  style={{ gridColumn: `${index + 2} / span ${MONTH_LABEL_WEEKS}`, gridRow: 1 }}
                >
                  {monthLabel(head.period)}
                </span>
              ),
          )}
          {labelledWeekdays.map((weekday) => (
            <span
              key={weekday}
              className="self-center pr-1.5 text-2xs leading-none text-muted-foreground"
              style={{ gridColumn: 1, gridRow: weekday + 2 }}
            >
              {weekdayName(weekday)}
            </span>
          ))}
          {weeks.map((week, weekIndex) =>
            week.map(
              (day, weekday) =>
                day && (
                  <span
                    key={day.period}
                    className={cn(
                      "aspect-square w-full rounded-[3px] transition-shadow",
                      levelClassNames[day.level],
                      active?.period === day.period && "ring-2 ring-foreground/60",
                    )}
                    style={{ gridColumn: weekIndex + 2, gridRow: weekday + 2 }}
                    onPointerEnter={() => setActive(day)}
                  />
                ),
            ),
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          <CalendarFigure
            label={t("personal.history.activeDays")}
            value={t("personal.history.periodCount.day", { count: activeDays })}
          />
          <CalendarFigure label={t("personal.history.totalTime")} value={formatDuration(totalSeconds)} />
          {!year && (
            <CalendarFigure
              label={t("personal.history.currentStreak")}
              value={t("personal.history.periodCount.day", { count: streaks.current })}
            />
          )}
          <CalendarFigure
            label={t("personal.history.longestStreak")}
            value={t("personal.history.periodCount.day", { count: streaks.longest })}
          />
        </dl>
        <div className="flex items-center gap-1.5 text-2xs text-muted-foreground" aria-hidden="true">
          <span>{t("personal.history.calendar.less")}</span>
          {levelClassNames.map((className) => (
            <span key={className} className={cn("h-3 w-3 rounded-[3px]", className)} />
          ))}
          <span>{t("personal.history.calendar.more")}</span>
        </div>
      </div>
    </figure>
  );
}

function CalendarFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

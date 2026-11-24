import type {
  ListeningCalendar,
  ListeningGranularity,
  ListeningNamedRange,
  ListeningPeriodStatistic,
  ListeningProfile,
  ListeningProfileTrait,
} from "@/lib/listeningApi";

export const LISTENING_HISTORY_PAGE_SIZE = 30;

/** Named report ranges in switcher order; the first is the default. */
export const LISTENING_REPORT_RANGES: readonly ListeningNamedRange[] = ["30d", "12m", "all"];

export type ListeningDurationParts =
  | { key: "hoursMinutes"; values: { hours: number; minutes: number } }
  | { key: "minutes"; values: { minutes: number } }
  | { key: "seconds"; values: { seconds: number } }
  | { key: "underSecond"; values: Record<string, never> };

/**
 * Whole hours and minutes for totals; seconds only below one minute, and an
 * average below one second stays distinct from none.
 */
export function listeningDurationParts(totalSeconds: number): ListeningDurationParts {
  const seconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  if (seconds === 0 && totalSeconds > 0 && Number.isFinite(totalSeconds)) return { key: "underSecond", values: {} };
  if (seconds < 60) return { key: "seconds", values: { seconds } };
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return { key: "minutes", values: { minutes: totalMinutes } };
  return { key: "hoursMinutes", values: { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 } };
}

/** The start of a series period (YYYY, YYYY-MM, or YYYY-MM-DD) as a UTC instant for calendar arithmetic. */
export function periodStart(period: string) {
  const [year, month = "01", day = "01"] = period.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

// 2024-01-01 is a Monday, so day offsets from it name the weekdays in Monday-first order.
export const MONDAY_UTC = Date.UTC(2024, 0, 1);

/** Bar length as a share of the largest value; a nonzero value never renders invisible. */
export function barPercent(value: number, maxValue: number) {
  if (value <= 0 || maxValue <= 0) return 0;
  return Math.max(4, Math.round((value / maxValue) * 100));
}

/**
 * Totals for the charted periods: periods with listening, their mean, and the
 * busiest period (the latest one on a tie). The mean stays unrounded, so it
 * reads the same as the report's time per active day once formatted.
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
    averageSeconds: listened.length > 0 ? totalSeconds / listened.length : 0,
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
    averageSeconds: total.days > 0 ? total.seconds / total.days : 0,
  }));
}

/**
 * Mean listening per day from Monday to Friday and per weekend day of a daily
 * series, counting the days without listening.
 */
export function weekPartAverages(series: readonly ListeningPeriodStatistic[]) {
  const workdays = { seconds: 0, days: 0 };
  const weekend = { seconds: 0, days: 0 };
  for (const entry of series) {
    const part = (periodStart(entry.period).getUTCDay() + 6) % 7 < 5 ? workdays : weekend;
    part.seconds += entry.listenedSeconds;
    part.days += 1;
  }
  return {
    workdaySeconds: workdays.days > 0 ? workdays.seconds / workdays.days : 0,
    weekendSeconds: weekend.days > 0 ? weekend.seconds / weekend.days : 0,
  };
}

/**
 * The daily listening a report's weekly rhythm reads: the report's own series
 * when it is daily, else the calendar's days from the report's first period
 * on. `pastYearOnly` says the report starts more than a week before the
 * calendar does. Null while a monthly or yearly report has no calendar yet.
 */
export function rhythmDays(
  series: readonly ListeningPeriodStatistic[],
  granularity: ListeningGranularity,
  calendarDays: readonly ListeningPeriodStatistic[] | null,
) {
  if (granularity === "day") return { days: series, pastYearOnly: false };
  if (!calendarDays) return null;
  const start = series[0] ? periodStart(series[0].period) : null;
  const earliest = calendarDays[0] ? periodStart(calendarDays[0].period) : null;
  const startDay = start ? start.toISOString().slice(0, 10) : "";
  return {
    days: calendarDays.filter((day) => day.period >= startDay),
    pastYearOnly: start !== null && earliest !== null && earliest.getTime() - start.getTime() > 7 * 86_400_000,
  };
}

/**
 * Calendar days a report covers, from its first period's start through
 * `today`, the day the report ends on. A report that does not name its last
 * day ends on the current UTC day.
 */
export function reportDayCount(series: readonly ListeningPeriodStatistic[], today?: string) {
  const first = series[0];
  if (!first) return 0;
  const last = periodStart(today ?? new Date().toISOString().slice(0, 10)).getTime();
  return Math.max(1, Math.round((last - periodStart(first.period).getTime()) / 86_400_000) + 1);
}

/** A part of a total as a whole percent; a nonzero part never rounds down to zero. */
export function sharePercent(value: number, total: number) {
  if (value <= 0 || total <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round((value / total) * 100)));
}

export type ListeningCalendarCell = ListeningPeriodStatistic & {
  /** 0 for no listening, then 1 through 4 by quartile of the days with listening; the busiest day is 4. */
  level: 0 | 1 | 2 | 3 | 4;
};

/**
 * A listening calendar as whole weeks, Monday first, oldest week first. Every
 * UTC day from the calendar's first day through its last is a cell; the days
 * of the first week before it and of the last week after it are null.
 */
export function listeningCalendarWeeks(calendar: ListeningCalendar) {
  const listened = new Map(calendar.days.map((day) => [day.date, day]));
  const levels = calendar.days
    .map((day) => day.listenedSeconds)
    .filter((seconds) => seconds > 0)
    .sort((left, right) => left - right);
  const quartile = (share: number) => levels[Math.min(levels.length - 1, Math.floor(levels.length * share))] ?? 0;
  const thresholds = [quartile(0.25), quartile(0.5), quartile(0.75)];
  const last = periodStart(calendar.to).getTime();
  const days: ListeningCalendarCell[] = [];
  const weeks: (ListeningCalendarCell | null)[][] = [];
  const first = periodStart(calendar.from);
  // The first day sits on its own weekday row, so a year that opens midweek starts partway down its first week.
  const offset = (first.getUTCDay() + 6) % 7;
  for (let time = first.getTime(), index = offset; time <= last; time += 86_400_000, index += 1) {
    const period = new Date(time).toISOString().slice(0, 10);
    const seconds = listened.get(period)?.listenedSeconds ?? 0;
    const cell: ListeningCalendarCell = {
      period,
      listenedSeconds: seconds,
      listenCount: listened.get(period)?.listenCount ?? 0,
      level: seconds > 0 ? ((1 + thresholds.filter((threshold) => seconds >= threshold).length) as 1 | 2 | 3 | 4) : 0,
    };
    days.push(cell);
    if (index % 7 === 0 || weeks.length === 0) weeks.push(Array.from({ length: 7 }, () => null));
    weeks[weeks.length - 1][index % 7] = cell;
  }
  return { weeks, days };
}

/** The hour of the day with the most listening (the earliest on a tie), or null without any. */
export function peakListeningHour(hours: readonly number[] | undefined) {
  const values = hours ?? [];
  let peak: number | null = null;
  for (let hour = 0; hour < values.length; hour += 1)
    if (values[hour] > 0 && (peak === null || values[hour] > values[peak])) peak = hour;
  return peak;
}

/** An hour of the day as a clock range, such as 22:00–23:00. */
export function hourRangeLabel(hour: number) {
  const clock = (value: number) => `${String(value % 24).padStart(2, "0")}:00`;
  return `${clock(hour)}–${clock(hour + 1)}`;
}

export type ListeningProfileTraitKind = "duration" | "release" | "popularity" | "rating";

// A trait further than this from the comparison's middle is worth a sentence.
const PROFILE_LEAN: Record<ListeningProfileTraitKind, number> = {
  duration: 0.1,
  release: 0.1,
  popularity: 0.1,
  rating: 0.05,
};

/** The fewest marked works a profile reads completion from. */
export const PROFILE_MARKS_MINIMUM = 3;

/** The fewest listened works the server reads preferred tags and traits from. */
export const PROFILE_WORK_MINIMUM = 3;

export type ListeningProfileStatement =
  | { kind: "tags"; names: string[] }
  | { kind: "lean"; trait: ListeningProfileTraitKind; side: "high" | "low" }
  | { kind: "marks"; works: number; finishedPercent: number; relistenPercent: number };

/**
 * What a profile says in words, in reading order: the two most preferred
 * tags, the work attribute the listening leans on most, how the account's
 * ratings compare, and how many of the marked works are finished.
 */
export function listeningProfileStatements(profile: ListeningProfile): ListeningProfileStatement[] {
  const statements: ListeningProfileStatement[] = [];
  const names = profile.tags.slice(0, 2).map((tag) => tag.name);
  if (names.length > 0) statements.push({ kind: "tags", names });
  const lean = (trait: ListeningProfileTrait | undefined) => (trait ? Math.abs(trait.position - 0.5) : 0);
  const side = (trait: ListeningProfileTrait) => (trait.position > 0.5 ? "high" : "low");
  const strongest = (["duration", "release", "popularity"] as const)
    .filter((kind) => lean(profile[kind]) >= PROFILE_LEAN[kind])
    .sort((left, right) => lean(profile[right]) - lean(profile[left]))[0];
  const strongestTrait = strongest && profile[strongest];
  if (strongest && strongestTrait) statements.push({ kind: "lean", trait: strongest, side: side(strongestTrait) });
  if (profile.rating && lean(profile.rating) >= PROFILE_LEAN.rating)
    statements.push({ kind: "lean", trait: "rating", side: side(profile.rating) });
  if (profile.marks.works >= PROFILE_MARKS_MINIMUM)
    statements.push({
      kind: "marks",
      works: profile.marks.works,
      finishedPercent: Math.round((profile.marks.finished / profile.marks.works) * 100),
      relistenPercent: Math.round((profile.marks.relisten / profile.marks.works) * 100),
    });
  return statements;
}

export type RadarPoint = { x: number; y: number };

/**
 * Points of a radar chart with one axis per value, the first pointing up and
 * the rest clockwise. A value is a share of `scale`, the chart's rim.
 */
export function radarPoints(values: readonly number[], scale: number, radius: number): RadarPoint[] {
  return values.map((value, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / values.length;
    const length = scale > 0 ? (Math.max(0, value) / scale) * radius : 0;
    return { x: Math.cos(angle) * length, y: Math.sin(angle) * length };
  });
}

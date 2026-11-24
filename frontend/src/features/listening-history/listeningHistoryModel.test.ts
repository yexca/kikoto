import { describe, expect, it } from "vitest";

import {
  barPercent,
  listeningCalendarWeeks,
  listeningDurationParts,
  listeningPeriodInsights,
  listeningStreaks,
  periodStart,
  reportDayCount,
  rhythmDays,
  sharePercent,
  weekPartAverages,
  weekdayAverages,
  hourRangeLabel,
  listeningProfileStatements,
  peakListeningHour,
  radarPoints,
} from "./listeningHistoryModel";

const days = (seconds: number[], start = "2026-03-02") =>
  seconds.map((listenedSeconds, index) => {
    const day = periodStart(start);
    day.setUTCDate(day.getUTCDate() + index);
    return { period: day.toISOString().slice(0, 10), listenedSeconds, listenCount: listenedSeconds > 0 ? 1 : 0 };
  });

describe("listening history presentation", () => {
  it("formats totals as hours and minutes and short sessions in seconds", () => {
    expect(listeningDurationParts(42)).toEqual({ key: "seconds", values: { seconds: 42 } });
    expect(listeningDurationParts(59 * 60 + 59)).toEqual({ key: "minutes", values: { minutes: 59 } });
    expect(listeningDurationParts(3 * 3600 + 5 * 60)).toEqual({
      key: "hoursMinutes",
      values: { hours: 3, minutes: 5 },
    });
    expect(listeningDurationParts(Number.NaN)).toEqual({ key: "seconds", values: { seconds: 0 } });
    // A weekday's average can fall below a second without being no listening.
    expect(listeningDurationParts(0.2)).toEqual({ key: "underSecond", values: {} });
  });

  it("reads day, month, and year periods as UTC starts", () => {
    expect(periodStart("2026-03-02").toISOString()).toBe("2026-03-02T00:00:00.000Z");
    expect(periodStart("2026-03").toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(periodStart("2026").toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps a listened period visible and an empty period flat", () => {
    expect(barPercent(0, 3600)).toBe(0);
    expect(barPercent(1, 3600)).toBe(4);
    expect(barPercent(3600, 3600)).toBe(100);
  });

  it("averages over periods with listening and reports the latest busiest period", () => {
    const series = [
      { period: "2026-01", listenedSeconds: 1800, listenCount: 1 },
      { period: "2026-02", listenedSeconds: 0, listenCount: 0 },
      { period: "2026-03", listenedSeconds: 600, listenCount: 2 },
      { period: "2026-04", listenedSeconds: 1800, listenCount: 3 },
    ];
    expect(listeningPeriodInsights(series)).toEqual({
      totalSeconds: 4200,
      activePeriods: 3,
      averageSeconds: 1400,
      peak: { period: "2026-04", listenedSeconds: 1800, listenCount: 3 },
    });
    expect(listeningPeriodInsights(series.map((entry) => ({ ...entry, listenedSeconds: 0 })))).toEqual({
      totalSeconds: 0,
      activePeriods: 0,
      averageSeconds: 0,
      peak: null,
    });
    // An unrounded mean formats like the time per active day it repeats.
    expect(
      listeningPeriodInsights(series.slice(2).map((entry, index) => ({ ...entry, listenedSeconds: index + 3 })))
        .averageSeconds,
    ).toBe(3.5);
  });

  it("counts the longest run and the current run, which may end before an unlistened latest period", () => {
    expect(listeningStreaks(days([60, 60, 60, 0, 60, 60]))).toEqual({ current: 2, longest: 3 });
    expect(listeningStreaks(days([60, 0, 60, 60, 0]))).toEqual({ current: 2, longest: 2 });
    expect(listeningStreaks(days([60, 60, 0, 0]))).toEqual({ current: 0, longest: 2 });
    expect(listeningStreaks([])).toEqual({ current: 0, longest: 0 });
  });

  it("averages each weekday over all of its days, Monday first", () => {
    // 2026-03-02 is a Monday; two weeks put two of each weekday in the range.
    const series = days([600, 0, 0, 0, 0, 0, 1200, 0, 0, 0, 0, 0, 0, 1800]);
    const averages = weekdayAverages(series);
    expect(averages.map((entry) => entry.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(averages[0].averageSeconds).toBe(300);
    expect(averages[6].averageSeconds).toBe(1500);
    expect(averages[3].averageSeconds).toBe(0);
  });

  it("covers the days from the first period through today", () => {
    expect(reportDayCount(days(new Array(14).fill(0)), "2026-03-15")).toBe(14);
    expect(reportDayCount([{ period: "2026-02", listenedSeconds: 0, listenCount: 0 }], "2026-03-15")).toBe(43);
    expect(reportDayCount([], "2026-03-15")).toBe(0);
  });

  it("keeps a small nonzero share visible", () => {
    expect(sharePercent(1, 1000)).toBe(1);
    expect(sharePercent(250, 1000)).toBe(25);
    expect(sharePercent(0, 1000)).toBe(0);
    expect(sharePercent(10, 0)).toBe(0);
  });
});

describe("listening rhythm", () => {
  it("averages Monday to Friday and the weekend over all of their days", () => {
    // Monday 2026-03-02 through Sunday 2026-03-15.
    const series = days([600, 0, 0, 0, 400, 1200, 0, 0, 0, 0, 0, 0, 600, 600]);
    expect(weekPartAverages(series)).toEqual({ workdaySeconds: 100, weekendSeconds: 600 });
    expect(weekPartAverages([])).toEqual({ workdaySeconds: 0, weekendSeconds: 0 });
  });

  it("reads a daily report's own series and the calendar's days for a longer one", () => {
    const calendarDays = days([60, 0, 120, 0], "2026-02-27");
    const daily = days([30, 30]);
    expect(rhythmDays(daily, "day", null)).toEqual({ days: daily, pastYearOnly: false });
    const monthly = [{ period: "2026-03", listenedSeconds: 120, listenCount: 1 }];
    expect(rhythmDays(monthly, "month", null)).toBeNull();
    // Only the calendar days of the report's range count.
    expect(rhythmDays(monthly, "month", calendarDays)).toEqual({ days: calendarDays.slice(2), pastYearOnly: false });
    // A report that starts long before the calendar is described by the calendar alone.
    const yearly = [{ period: "2024", listenedSeconds: 180, listenCount: 2 }];
    expect(rhythmDays(yearly, "year", calendarDays)).toEqual({ days: calendarDays, pastYearOnly: true });
  });
});

describe("listening calendar", () => {
  it("lays out whole Monday-first weeks and leaves days after the last one empty", () => {
    const { weeks, days } = listeningCalendarWeeks({
      from: "2026-02-23",
      to: "2026-03-04",
      days: [
        { date: "2026-02-23", listenedSeconds: 600, listenCount: 1 },
        { date: "2026-03-04", listenedSeconds: 60, listenCount: 2 },
      ],
    });
    expect(days).toHaveLength(10);
    expect(weeks).toHaveLength(2);
    expect(weeks[0].map((day) => day?.period)).toEqual([
      "2026-02-23",
      "2026-02-24",
      "2026-02-25",
      "2026-02-26",
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
    expect(weeks[1].map((day) => day?.period ?? null)).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      null,
      null,
      null,
      null,
    ]);
    expect(weeks[1][2]).toMatchObject({ listenedSeconds: 60, listenCount: 2 });
    expect(weeks[1][0]).toMatchObject({ listenedSeconds: 0, listenCount: 0, level: 0 });
  });

  it("shades days by quartile of the days with listening, with the busiest at the top level", () => {
    const { days } = listeningCalendarWeeks({
      from: "2026-03-02",
      to: "2026-03-08",
      days: [100, 200, 300, 400, 5000].map((listenedSeconds, index) => ({
        date: `2026-03-0${index + 2}`,
        listenedSeconds,
        listenCount: 1,
      })),
    });
    expect(days.map((day) => day.level)).toEqual([1, 2, 3, 4, 4, 0, 0]);
    const single = listeningCalendarWeeks({
      from: "2026-03-02",
      to: "2026-03-02",
      days: [{ date: "2026-03-02", listenedSeconds: 30, listenCount: 1 }],
    });
    expect(single.days[0].level).toBe(4);
  });
});

describe("calendar years and hours", () => {
  it("starts a year on the weekday of its first day", () => {
    // 2025-01-01 is a Wednesday.
    const { weeks, days } = listeningCalendarWeeks({
      from: "2025-01-01",
      to: "2025-01-07",
      days: [{ date: "2025-01-06", listenedSeconds: 60, listenCount: 1 }],
    });
    expect(days).toHaveLength(7);
    expect(weeks.map((week) => week.map((day) => day?.period.slice(8) ?? null))).toEqual([
      [null, null, "01", "02", "03", "04", "05"],
      ["06", "07", null, null, null, null, null],
    ]);
  });

  it("names the busiest hour, the earliest on a tie", () => {
    const hours = Array.from({ length: 24 }, () => 0);
    expect(peakListeningHour(hours)).toBeNull();
    expect(peakListeningHour(undefined)).toBeNull();
    hours[22] = 600;
    hours[7] = 600;
    hours[23] = 30;
    expect(peakListeningHour(hours)).toBe(7);
    expect(hourRangeLabel(7)).toBe("07:00–08:00");
    expect(hourRangeLabel(23)).toBe("23:00–00:00");
  });
});

describe("taste profile", () => {
  const entry = (id: number, name: string) => ({ id, name, listenedSeconds: 60, listenCount: 1, workCount: 1 });
  const trait = (position: number) => ({ value: 1, libraryValue: 1, position, workCount: 3 });
  const profile = {
    range: "30d" as const,
    listenedSeconds: 600,
    workCount: 4,
    libraryWorkCount: 10,
    tags: [entry(1, "Example Tag A"), entry(2, "Example Tag B"), entry(3, "Example Tag C")],
    marks: { works: 0, finished: 0, relisten: 0 },
  };

  it("says the leading tags, the strongest lean, the rating lean, and the marks", () => {
    expect(
      listeningProfileStatements({
        ...profile,
        duration: trait(0.72),
        release: trait(0.2),
        popularity: trait(0.55),
        rating: trait(0.4),
        marks: { works: 8, finished: 6, relisten: 1 },
      }),
    ).toEqual([
      { kind: "tags", names: ["Example Tag A", "Example Tag B"] },
      { kind: "lean", trait: "release", side: "low" },
      { kind: "lean", trait: "rating", side: "low" },
      { kind: "marks", works: 8, finishedPercent: 75, relistenPercent: 13 },
    ]);
  });

  it("stays quiet about what sits near the library or rests on too few works", () => {
    expect(
      listeningProfileStatements({
        ...profile,
        tags: [],
        duration: trait(0.55),
        rating: trait(0.52),
        marks: { works: 2, finished: 2, relisten: 0 },
      }),
    ).toEqual([]);
  });

  it("draws a radar from the top, clockwise, as shares of the rim", () => {
    const points = radarPoints([1, 0.5, 0, 2], 2, 100);
    expect(points.map((point) => [Math.round(point.x), Math.round(point.y)])).toEqual([
      [0, -50],
      [25, 0],
      [0, 0],
      [-100, 0],
    ]);
    expect(radarPoints([1], 0, 100)).toEqual([{ x: 0, y: -0 }]);
  });
});

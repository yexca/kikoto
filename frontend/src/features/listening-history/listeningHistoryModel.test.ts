import { describe, expect, it } from "vitest";

import {
  barPercent,
  listeningDurationParts,
  listeningPeriodInsights,
  listeningStreaks,
  periodStart,
  reportDayCount,
  sharePercent,
  weekdayAverages,
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
    const now = new Date("2026-03-15T22:00:00Z");
    expect(reportDayCount(days(new Array(14).fill(0)), now)).toBe(14);
    expect(reportDayCount([{ period: "2026-02", listenedSeconds: 0, listenCount: 0 }], now)).toBe(43);
    expect(reportDayCount([], now)).toBe(0);
  });

  it("keeps a small nonzero share visible", () => {
    expect(sharePercent(1, 1000)).toBe(1);
    expect(sharePercent(250, 1000)).toBe(25);
    expect(sharePercent(0, 1000)).toBe(0);
    expect(sharePercent(10, 0)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import { barPercent, listeningDurationParts, listeningPeriodInsights, periodStart } from "./listeningHistoryModel";

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
});

import { describe, expect, it } from "vitest";

import { dailyBarPercent, dailyListeningSeries, listeningDurationParts } from "./listeningHistoryModel";

describe("listening history presentation", () => {
  it("fills the last 30 UTC days ending today, oldest first", () => {
    const now = new Date("2026-03-01T23:30:00-05:00"); // 04:30 UTC on March 2
    const series = dailyListeningSeries(
      [
        { date: "2026-03-02", listenedSeconds: 600, listenCount: 2 },
        { date: "2026-02-01", listenedSeconds: 60, listenCount: 1 },
        { date: "2026-01-01", listenedSeconds: 999, listenCount: 9 },
      ],
      now,
    );
    expect(series).toHaveLength(30);
    expect(series[0]).toEqual({ date: "2026-02-01", listenedSeconds: 60, listenCount: 1 });
    expect(series[29]).toEqual({ date: "2026-03-02", listenedSeconds: 600, listenCount: 2 });
    expect(series[1]).toEqual({ date: "2026-02-02", listenedSeconds: 0, listenCount: 0 });
  });

  it("formats totals as hours and minutes and short sessions in seconds", () => {
    expect(listeningDurationParts(42)).toEqual({ key: "seconds", values: { seconds: 42 } });
    expect(listeningDurationParts(59 * 60 + 59)).toEqual({ key: "minutes", values: { minutes: 59 } });
    expect(listeningDurationParts(3 * 3600 + 5 * 60)).toEqual({
      key: "hoursMinutes",
      values: { hours: 3, minutes: 5 },
    });
    expect(listeningDurationParts(Number.NaN)).toEqual({ key: "seconds", values: { seconds: 0 } });
  });

  it("keeps a listened day visible and an empty day flat", () => {
    expect(dailyBarPercent(0, 3600)).toBe(0);
    expect(dailyBarPercent(1, 3600)).toBe(4);
    expect(dailyBarPercent(3600, 3600)).toBe(100);
  });
});

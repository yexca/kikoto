import { describe, expect, it } from "vitest";

import { MARQUEE_ORIGIN_PAUSE_MS, MARQUEE_SPEED_PX_PER_SECOND, marqueeTimeline } from "./overflowMarqueeTiming";

describe("marqueeTimeline", () => {
  it("keeps lines that fit still", () => {
    expect(marqueeTimeline([0, 0])).toBeNull();
    const timeline = marqueeTimeline([320, 0]);
    expect(timeline?.lines[1]).toBeNull();
    expect(timeline?.lines[0]).not.toBeNull();
  });

  it("starts every scrolling line together and lets a shorter one wait at the start of the next cycle", () => {
    const timeline = marqueeTimeline([320, 160]);
    expect(timeline?.durationMs).toBe(MARQUEE_ORIGIN_PAUSE_MS + (320 / MARQUEE_SPEED_PX_PER_SECOND) * 1000);
    const [longer, shorter] = timeline?.lines ?? [];
    const pauseOffset = MARQUEE_ORIGIN_PAUSE_MS / (timeline?.durationMs ?? 1);

    for (const frames of [longer, shorter]) {
      expect(frames?.slice(0, 2)).toEqual([
        { offset: 0, transform: "translateX(0)" },
        { offset: pauseOffset, transform: "translateX(0)" },
      ]);
    }
    expect(longer).toHaveLength(3);
    expect(longer?.[2]).toEqual({ offset: 1, transform: "translateX(-320px)" });
    // Same speed: the shorter line arrives early, then holds until the cycle wraps.
    const shorterArrival =
      (MARQUEE_ORIGIN_PAUSE_MS + (160 / MARQUEE_SPEED_PX_PER_SECOND) * 1000) / (timeline?.durationMs ?? 1);
    expect(shorter?.slice(2)).toEqual([
      { offset: shorterArrival, transform: "translateX(-160px)" },
      { offset: 1, transform: "translateX(-160px)" },
    ]);
  });
});

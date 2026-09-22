import { describe, expect, it } from "vitest";

import {
  bufferedEndAt,
  NEXT_TRACK_PRELOAD_WINDOW_SECONDS,
  nextAutoAdvanceIndex,
  shouldPreloadNextTrack,
} from "./nextTrackPreload";

describe("nextAutoAdvanceIndex", () => {
  it("follows end-of-track queue advancement", () => {
    expect(nextAutoAdvanceIndex(0, 3, "order")).toBe(1);
    expect(nextAutoAdvanceIndex(2, 3, "order")).toBeNull();
    expect(nextAutoAdvanceIndex(2, 3, "loop")).toBe(0);
  });

  it("does not preload a repeated or lone track", () => {
    expect(nextAutoAdvanceIndex(0, 3, "single")).toBeNull();
    expect(nextAutoAdvanceIndex(0, 1, "loop")).toBeNull();
    expect(nextAutoAdvanceIndex(5, 3, "order")).toBeNull();
  });
});

describe("shouldPreloadNextTrack", () => {
  const base = { playing: true, currentTime: 10, duration: 600, bufferedEnd: 60 };

  it("waits until the current track nears its end", () => {
    expect(shouldPreloadNextTrack(base)).toBe(false);
    expect(shouldPreloadNextTrack({ ...base, currentTime: base.duration - NEXT_TRACK_PRELOAD_WINDOW_SECONDS })).toBe(
      true,
    );
  });

  it("starts early when the current track is already fully buffered", () => {
    expect(shouldPreloadNextTrack({ ...base, bufferedEnd: 599.8 })).toBe(true);
  });

  it("never preloads while paused or before the duration is known", () => {
    expect(shouldPreloadNextTrack({ ...base, playing: false, currentTime: 590 })).toBe(false);
    expect(shouldPreloadNextTrack({ ...base, duration: 0, currentTime: 0 })).toBe(false);
    expect(shouldPreloadNextTrack({ ...base, duration: Number.NaN })).toBe(false);
  });
});

describe("bufferedEndAt", () => {
  const media = (ranges: [number, number][], currentTime: number) => ({
    currentTime,
    buffered: {
      length: ranges.length,
      start: (index: number) => ranges[index][0],
      end: (index: number) => ranges[index][1],
    } as TimeRanges,
  });

  it("reads the range around the playback position", () => {
    expect(
      bufferedEndAt(
        media(
          [
            [0, 30],
            [100, 200],
          ],
          120,
        ),
      ),
    ).toBe(200);
    expect(bufferedEndAt(media([[0, 30]], 50))).toBe(0);
  });
});

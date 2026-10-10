import { describe, expect, it } from "vitest";

import { parseTimedLyrics } from "./timedLyrics";

function times(text: string) {
  return parseTimedLyrics(text).lines.map((line) => [line.time, line.text]);
}

describe("parseTimedLyrics", () => {
  it("reads LRC minute tags with either fraction separator", () => {
    expect(times("[00:01.50]first\n[01:02]second\n[01:02:50]third\n[02:03.5][02:04.250]repeated")).toEqual([
      [1.5, "first"],
      [62, "second"],
      [62.5, "third"],
      [123.5, "repeated"],
      [124.25, "repeated"],
    ]);
  });

  it("keeps lines timed past 99 minutes", () => {
    expect(times("[99:59.00]before\n[100:00.00]after\n[125:30.25]later")).toEqual([
      [5999, "before"],
      [6000, "after"],
      [7530.25, "later"],
    ]);
  });

  it("reads LRC tags that carry an hour field", () => {
    expect(times("[00:59:59.00]before\n[01:02:03.50]after")).toEqual([
      [3599, "before"],
      [3723.5, "after"],
    ]);
  });

  it("ignores metadata tags and reports untimed text", () => {
    expect(times("[ar:Example Voice]\n[offset:500]\n[00:01.00]line")).toEqual([[1, "line"]]);
    expect(parseTimedLyrics("plain text\nwithout tags")).toEqual({ timed: false, lines: [] });
  });

  it("reads WebVTT and SRT cues", () => {
    expect(times("WEBVTT\n\n00:01.000 --> 00:02.000\nfirst\n\n01:00:03.500 --> 01:00:04.000\nsecond\nline")).toEqual([
      [1, "first"],
      [3603.5, "second line"],
    ]);
    expect(times("1\n00:00:05,250 --> 00:00:06,000\ncue")).toEqual([[5.25, "cue"]]);
  });
});

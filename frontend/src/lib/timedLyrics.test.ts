import { describe, expect, it } from "vitest";

import { activeTimedLyricIndex, firstReachableLyricIndex, offsetTimedLyrics, parseTimedLyrics } from "./timedLyrics";

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

  it("reads ASS dialogue in its declared field order", () => {
    const ass = [
      "[Script Info]",
      "Title: Synthetic",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not shown",
      "Dialogue: 0,0:00:05.50,0:00:07.00,Default,,0,0,0,,{\\an8}second, with a comma",
      "Dialogue: 0,0:00:01.25,0:00:03.00,Default,,0,0,0,,first\\Nline",
      "Dialogue: 0,1:02:03.00,1:02:04.00,Default,,0,0,0,,{\\i1}{\\i0}",
    ].join("\n");
    expect(times(ass)).toEqual([
      [1.25, "first line"],
      [5.5, "second, with a comma"],
    ]);
    const reordered = "Format: Start, End, Style, Text\nDialogue: 0:00:02.00,0:00:03.00,Default,reordered";
    expect(times(reordered)).toEqual([[2, "reordered"]]);
  });

  it("reads WebVTT and SRT cues", () => {
    expect(times("WEBVTT\n\n00:01.000 --> 00:02.000\nfirst\n\n01:00:03.500 --> 01:00:04.000\nsecond\nline")).toEqual([
      [1, "first"],
      [3603.5, "second line"],
    ]);
    expect(times("1\n00:00:05,250 --> 00:00:06,000\ncue")).toEqual([[5.25, "cue"]]);
  });
});

describe("offsetTimedLyrics", () => {
  const parsed = parseTimedLyrics("[00:01.00]first\n[00:05.00]second");

  it("moves every line by the listener's offset, which the active line then follows", () => {
    const later = offsetTimedLyrics(parsed, 1500);
    expect(later.lines.map((line) => line.time)).toEqual([2.5, 6.5]);
    expect(activeTimedLyricIndex(parsed.lines, 5.2)).toBe(1);
    expect(activeTimedLyricIndex(later.lines, 5.2)).toBe(0);
  });

  it("keeps lines moved before the start distinct, with only the last of them current at the start", () => {
    const opening = parseTimedLyrics("[00:01.00]one\n[00:02.00]two\n[00:04.00]three\n[00:06.00]four\n[00:08.00]five");
    const earlier = offsetTimedLyrics(opening, -5000);
    expect(earlier.lines.map((line) => line.time)).toEqual([-4, -3, -1, 1, 3]);
    expect(firstReachableLyricIndex(earlier.lines)).toBe(2);
    expect(activeTimedLyricIndex(earlier.lines, 0)).toBe(2);
    expect(activeTimedLyricIndex(earlier.lines, 1)).toBe(3);
    expect(activeTimedLyricIndex(earlier.lines, 3)).toBe(4);
    expect(firstReachableLyricIndex(opening.lines)).toBe(0);
  });

  it("leaves untimed text and a zero offset alone", () => {
    const untimed = parseTimedLyrics("plain text");
    expect(offsetTimedLyrics(untimed, 1000)).toBe(untimed);
    expect(offsetTimedLyrics(parsed, 0)).toBe(parsed);
  });
});

import { describe, expect, it } from "vitest";

import { activeTimedLyricIndex, firstReachableLyricIndex, offsetTimedLyrics, type ParsedLyrics } from "./timedLyrics";

function timed(...times: number[]): ParsedLyrics {
  return { timed: true, lines: times.map((time, index) => ({ time, text: `line ${index + 1}` })) };
}

describe("offsetTimedLyrics", () => {
  const parsed = timed(1, 5);

  it("moves every line by the listener's offset, which the active line then follows", () => {
    const later = offsetTimedLyrics(parsed, 1500);
    expect(later.lines.map((line) => line.time)).toEqual([2.5, 6.5]);
    expect(activeTimedLyricIndex(parsed.lines, 5.2)).toBe(1);
    expect(activeTimedLyricIndex(later.lines, 5.2)).toBe(0);
  });

  it("keeps lines moved before the start distinct, with only the last of them current at the start", () => {
    const opening = timed(1, 2, 4, 6, 8);
    const earlier = offsetTimedLyrics(opening, -5000);
    expect(earlier.lines.map((line) => line.time)).toEqual([-4, -3, -1, 1, 3]);
    expect(firstReachableLyricIndex(earlier.lines)).toBe(2);
    expect(activeTimedLyricIndex(earlier.lines, 0)).toBe(2);
    expect(activeTimedLyricIndex(earlier.lines, 1)).toBe(3);
    expect(activeTimedLyricIndex(earlier.lines, 3)).toBe(4);
    expect(firstReachableLyricIndex(opening.lines)).toBe(0);
  });

  it("keeps the marker of the line naming the models of AI-made lyrics", () => {
    const withCredit: ParsedLyrics = { timed: true, lines: [{ time: 0, text: "credit", attribution: true }] };
    expect(offsetTimedLyrics(withCredit, 500).lines).toEqual([{ time: 0.5, text: "credit", attribution: true }]);
  });

  it("leaves untimed text and a zero offset alone", () => {
    const untimed: ParsedLyrics = { timed: false, lines: [] };
    expect(offsetTimedLyrics(untimed, 1000)).toBe(untimed);
    expect(offsetTimedLyrics(parsed, 0)).toBe(parsed);
  });
});

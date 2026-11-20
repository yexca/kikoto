import { describe, expect, it } from "vitest";

import { countTextLines, formatLyricsTime, lyricsView } from "./textPreviewModel";

describe("text preview model", () => {
  it("shows the lines and song tags of timed lyrics", () => {
    expect(
      lyricsView({
        timed: true,
        sparse: false,
        tags: [{ key: "ti", value: "Example Work" }],
        lines: [
          { time: 0.88, text: "Chorus" },
          { time: 5.38, text: "Second line", attribution: true },
        ],
      }),
    ).toEqual({
      tags: [{ key: "ti", value: "Example Work" }],
      lines: [
        { timeSeconds: 0.88, text: "Chorus" },
        { timeSeconds: 5.38, text: "Second line" },
      ],
    });
  });

  it("keeps a script with occasional timestamps, untimed text, and a failed read as plain text", () => {
    expect(lyricsView({ timed: true, sparse: true, tags: [], lines: [{ time: 30, text: "A cue" }] })).toBeNull();
    expect(lyricsView({ timed: false, sparse: false, tags: [], lines: [] })).toBeNull();
    expect(lyricsView(null)).toBeNull();
  });

  it("formats lyric times and counts lines without a trailing empty line", () => {
    expect(formatLyricsTime(65.9)).toBe("1:05");
    expect(formatLyricsTime(3725)).toBe("1:02:05");
    expect(countTextLines("one\ntwo\n")).toBe(2);
    expect(countTextLines("")).toBe(0);
  });
});

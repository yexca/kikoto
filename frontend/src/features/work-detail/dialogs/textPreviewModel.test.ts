import { describe, expect, it } from "vitest";

import { countTextLines, formatLyricsTime, parseLyrics } from "./textPreviewModel";

describe("text preview model", () => {
  it("reads LRC lyrics with header tags, repeated stamps, and word timing", () => {
    const parsed = parseLyrics(
      [
        "[ti:Example Work]",
        "[ar:Example Voice]",
        "[offset:+120]",
        "[00:05.50]Second line",
        "[00:01.00][00:10]Chorus",
        "[00:12.25]<00:12.25>Word <00:13.00>timed",
        "",
      ].join("\r\n"),
    );

    expect(parsed?.tags).toEqual([
      { key: "ti", value: "Example Work" },
      { key: "ar", value: "Example Voice" },
    ]);
    expect(parsed?.lines).toEqual([
      { timeSeconds: 1, text: "Chorus" },
      { timeSeconds: 5.5, text: "Second line" },
      { timeSeconds: 10, text: "Chorus" },
      { timeSeconds: 12.25, text: "Word timed" },
    ]);
  });

  it("reads WebVTT and SRT cues without their identifiers, settings, or voice markup", () => {
    const vtt = parseLyrics(
      [
        "WEBVTT",
        "",
        "1",
        "00:00:19.941 --> 00:00:21.133",
        "First cue",
        "",
        "2",
        "00:01:02.500 --> 00:01:05.000 align:start",
        "<v Example Voice>Second</v> cue",
      ].join("\n"),
    );
    expect(vtt).toEqual({
      tags: [],
      lines: [
        { timeSeconds: 19.941, text: "First cue" },
        { timeSeconds: 62.5, text: "Second cue" },
      ],
    });

    expect(parseLyrics("1\n00:00:01,500 --> 00:00:03,000\nHello\n")?.lines).toEqual([
      { timeSeconds: 1.5, text: "Hello" },
    ]);
  });

  it("reads LRC lyrics whose stamps pass 99 minutes or carry an hour field", () => {
    const lyrics = parseLyrics("[99:59.00]before\n[100:00.00]after\n[01:45:00.50]with hours");

    expect(lyrics?.lines).toEqual([
      { timeSeconds: 5999, text: "before" },
      { timeSeconds: 6000, text: "after" },
      { timeSeconds: 6300.5, text: "with hours" },
    ]);
  });

  it("keeps a script with occasional timestamps as plain text", () => {
    expect(parseLyrics("Scene one\n[00:30]A cue\nScene two\nScene three")).toBeNull();
    expect(parseLyrics("Synthetic notes")).toBeNull();
    expect(parseLyrics("")).toBeNull();
  });

  it("formats lyric times and counts lines without a trailing empty line", () => {
    expect(formatLyricsTime(65.9)).toBe("1:05");
    expect(formatLyricsTime(3725)).toBe("1:02:05");
    expect(countTextLines("one\ntwo\n")).toBe(2);
    expect(countTextLines("")).toBe(0);
  });
});

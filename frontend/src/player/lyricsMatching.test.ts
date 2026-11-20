import { describe, expect, it } from "vitest";

import { lyricsChoiceDisplayLabel, type LyricsChoice } from "./lyricsMatching";

describe("lyricsChoiceDisplayLabel", () => {
  it("uses relative paths to distinguish duplicate lyric file names", () => {
    const choices = [
      {
        mediaItemId: 1,
        locationId: 1,
        title: "lyrics.lrc",
        path: "library/RJ00000000/Disc 1/lyrics.lrc",
        displayPath: "Disc 1/lyrics.lrc",
        reason: "same_stem",
      },
      {
        mediaItemId: 2,
        locationId: 2,
        title: "lyrics.lrc",
        path: "library/RJ00000000/Disc 2/lyrics.lrc",
        displayPath: "Disc 2/lyrics.lrc",
        reason: "same_stem",
      },
    ] satisfies LyricsChoice[];

    expect(lyricsChoiceDisplayLabel(choices[0], choices)).toBe("Disc 1/lyrics.lrc");
    expect(lyricsChoiceDisplayLabel(choices[1], choices)).toBe("Disc 2/lyrics.lrc");
  });
});

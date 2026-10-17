import { describe, expect, it } from "vitest";

import { demoLyricsText, demoLyricsTranslations } from "./demoLyricsTaskModel";
import type { TranslationSourceFile } from "./lyricsTaskModel";

function source(locationId: number): TranslationSourceFile {
  return { locationId, title: `${locationId}.vtt`, remote: false, sourceName: "" };
}

describe("demoLyricsTranslations", () => {
  it("samples tracks with lyrics, reading their file and targeting a language they lack", () => {
    const files = new Map([
      [11, source(111)],
      [12, source(112)],
    ]);
    const samples = demoLyricsTranslations(
      [
        { audioId: 1, lyrics: new Map() },
        { audioId: 2, lyrics: new Map([["ja-jp", 11]]) },
        { audioId: 3, lyrics: new Map([["", 12]]) },
      ],
      files,
      "ja-jp",
    );

    expect(samples.map((sample) => [sample.audioMediaItemId, sample.lyricsLocationId, sample.state])).toEqual([
      [2, 111, "ready"],
      [3, 112, "requesting"],
    ]);
    for (const sample of samples) expect(["", "ja-jp"]).not.toContain(sample.targetLanguage);
    expect(samples[0].previewId).toBeTruthy();
    expect(samples[1].previewId).toBeUndefined();
  });
});

describe("demoLyricsText", () => {
  it("writes WebVTT cues that end within the track", () => {
    const text = demoLyricsText(30, (number) => `Sample ${number}`);
    const times = [...text.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})/g)].map(
      (match) => {
        const [, , , , , h, m, s, ms] = match.map(Number);
        return h * 3600 + m * 60 + s + ms / 1000;
      },
    );

    expect(text.startsWith("WEBVTT\n\n")).toBe(true);
    expect(text).toContain("Sample 1");
    expect(times.length).toBeGreaterThan(1);
    expect(Math.max(...times)).toBeLessThanOrEqual(30);
  });
});

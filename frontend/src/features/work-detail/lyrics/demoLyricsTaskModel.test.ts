import { describe, expect, it } from "vitest";

import { demoLyricsText } from "./demoLyricsTaskModel";

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

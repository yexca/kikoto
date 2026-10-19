import { describe, expect, it } from "vitest";

import { applyLyricsOffsetOverride, clampLyricsOffset, lyricsPreferencePersists } from "./lyricsPreference";
import type { PlayerTrack } from "./playerTypes";

describe("lyricsPreferencePersists", () => {
  it("stores the choice for a library audio track", () => {
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "audio", lyricsPreferencePersistable: true })).toBe(true);
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "audio", progressRecordable: true })).toBe(true);
  });

  it("keeps the choice in the session for a video track, which the server does not store one for", () => {
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "video", lyricsPreferencePersistable: true })).toBe(false);
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "video", progressRecordable: true })).toBe(false);
  });

  it("keeps the choice in the session for previews and unsaved tracks", () => {
    expect(lyricsPreferencePersists({ mediaItemId: -1, kind: "audio", progressRecordable: true })).toBe(false);
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "audio", lyricsPreferencePersistable: false })).toBe(false);
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "audio" })).toBe(false);
  });
});

describe("lyrics offset", () => {
  it("stays within 30 seconds either way", () => {
    expect(clampLyricsOffset(45_000)).toBe(30_000);
    expect(clampLyricsOffset(-31_000)).toBe(-30_000);
    expect(clampLyricsOffset(1234.4)).toBe(1234);
    expect(clampLyricsOffset(Number.NaN)).toBe(0);
  });

  it("carries a changed offset onto a track queued from older page data", () => {
    const track = { mediaItemId: 5, lyricsOffsetMs: 0 } as PlayerTrack;
    expect(applyLyricsOffsetOverride(track, { "media:5": -1500 }).lyricsOffsetMs).toBe(-1500);
    expect(applyLyricsOffsetOverride(track, { "media:6": -1500 })).toBe(track);
  });
});

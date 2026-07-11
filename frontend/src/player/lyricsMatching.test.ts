import { describe, expect, it } from "vitest";

import type { MediaItem } from "../lib/api";
import { findLyricsMatch } from "./lyricsMatching";

function lyric(path: string, id: number): MediaItem {
  return {
    id,
    parentId: null,
    kind: "file",
    title: path,
    discNo: null,
    trackNo: null,
    durationSeconds: null,
    sizeBytes: null,
    fingerprint: path,
    progress: null,
    locations: [{ id, fileSourceId: 1, fileSourceCode: "local", fileSourceName: "Local", locationType: "local", path, streamUrl: "", downloadUrl: "", remoteHash: "", sizeBytes: null, durationSeconds: null, availability: "available", lastCheckedAt: null }],
  };
}

describe("findLyricsMatch", () => {
  it("matches an audio filename preserved inside a VTT sidecar name", () => {
    const match = findLyricsMatch("work/MP3/01_abc.mp3", [lyric("work/MP3/01_abc.mp3.vtt", 9)]);
    expect(match?.locationId).toBe(9);
    expect(match?.mediaItemId).toBe(9);
  });

  it("prefers the same directory when duplicate stems exist", () => {
    expect(findLyricsMatch("work/main/01_abc.wav", [lyric("work/bonus/01_abc.vtt", 1), lyric("work/main/01_abc.srt", 2)])?.locationId).toBe(2);
  });

  it("uses an explicitly generic shared lyric only inside the audio folder", () => {
    expect(findLyricsMatch("work/main/01_abc.wav", [lyric("work/lyrics.vtt", 1), lyric("work/main/字幕.vtt", 2)])?.locationId).toBe(2);
  });

  it("chooses deterministically between equal candidates", () => {
    expect(findLyricsMatch("work/01_abc.wav", [lyric("work/01_abc.srt", 2), lyric("work/01_abc.vtt", 1)])?.locationId).toBe(1);
  });
});

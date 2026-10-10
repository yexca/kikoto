import { describe, expect, it } from "vitest";

import type { MediaItem } from "../lib/api";
import { findLyricsMatch, lyricsChoiceDisplayLabel, type LyricsChoice } from "./lyricsMatching";

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
    locations: [
      {
        id,
        fileSourceId: 1,
        fileSourceCode: "local",
        fileSourceName: "Local",
        locationType: "local",
        path,
        streamUrl: "",
        downloadUrl: "",
        remoteHash: "",
        sizeBytes: null,
        durationSeconds: null,
        availability: "available",
        lastCheckedAt: null,
      },
    ],
  };
}

describe("findLyricsMatch", () => {
  it("matches an audio filename preserved inside a VTT sidecar name", () => {
    const match = findLyricsMatch("work/MP3/01_abc.mp3", [lyric("work/MP3/01_abc.mp3.vtt", 9)]);
    expect(match?.locationId).toBe(9);
    expect(match?.mediaItemId).toBe(9);
  });

  it("prefers the same directory when duplicate stems exist", () => {
    expect(
      findLyricsMatch("work/main/01_abc.wav", [lyric("work/bonus/01_abc.vtt", 1), lyric("work/main/01_abc.srt", 2)])
        ?.locationId,
    ).toBe(2);
  });

  it("uses an explicitly generic shared lyric only inside the audio folder", () => {
    expect(
      findLyricsMatch("work/main/01_abc.wav", [lyric("work/lyrics.vtt", 1), lyric("work/main/字幕.vtt", 2)])
        ?.locationId,
    ).toBe(2);
  });

  it("chooses deterministically between equal candidates", () => {
    expect(
      findLyricsMatch("work/01_abc.wav", [lyric("work/01_abc.srt", 2), lyric("work/01_abc.vtt", 1)])?.locationId,
    ).toBe(1);
  });

  // The same pairs as TestLyricsCandidateMatchesTrackLikeThePlayer on the server.
  it.each([
    ["work/MP3/01_abc.mp3", "work/MP3/01_abc.mp3.vtt", true],
    ["work/main/01_abc.wav", "work/main/01_abc.srt", true],
    ["work/main/01_abc.wav", "work/bonus/01_abc.vtt", true],
    ["Work\\Main\\Track01.FLAC", "work/main/track01.LRC", true],
    ["work/01. Opening (v2).mp3", "work/subs/opening.vtt", true],
    ["work/01　はじまり.mp3", "work/subs/はじまり.txt", true],
    ["work/main/01_abc.wav", "work/main/字幕.vtt", true],
    ["work/main/01_abc.wav", "work/lyrics.vtt", false],
    ["work/01_abc.mp3", "work/readme.txt", false],
    ["work/01_abc.mp3", "work/台本.txt", false],
    ["work/01_a.mp3", "work/subs/02_a.txt", false],
    ["work/01_abc.mp3", "work/02_def.vtt", false],
  ])("decides whether %s takes %s as lyrics", (audioPath, lyricsPath, matched) => {
    expect(findLyricsMatch(audioPath, [lyric(lyricsPath, 1)]) !== null).toBe(matched);
  });

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

import { describe, expect, it } from "vitest";

import type { MediaItem } from "@/lib/api";

import { lyricsFileTrackCounts, managedLyricsLanguage } from "./managedLyricsModel";

const root = "Library/RJ00000000";

function item(id: number, kind: string, path: string, lyricsMediaItemId: number | null = null): MediaItem {
  return {
    id,
    parentId: null,
    kind,
    title: path,
    discNo: null,
    trackNo: null,
    durationSeconds: kind === "audio" ? 60 : null,
    sizeBytes: 10,
    fingerprint: path,
    progress: null,
    lyricsAssignments: lyricsMediaItemId ? [{ language: "zh-cn", lyricsMediaItemId }] : [],
    locations: [
      {
        id: id + 100,
        fileSourceId: 1,
        fileSourceCode: "local",
        fileSourceName: "Local",
        locationType: "local",
        path: `${root}/${path}`,
        streamUrl: "",
        downloadUrl: "",
        remoteHash: "",
        sizeBytes: 10,
        durationSeconds: null,
        availability: "available",
        lastCheckedAt: null,
      },
    ],
  };
}

const items = [
  item(1, "audio", "mp3/01 Opening.mp3", 4),
  item(2, "audio", "mp3/02 Ending.mp3"),
  item(3, "text", "mp3/01 Opening.mp3.vtt"),
  item(4, "text", "lyrics_kikoto/zh-hans/mp3/01 Opening.mp3.vtt"),
  item(5, "text", "lyrics_kikoto/fallback/notes/02.lrc"),
  item(6, "image", "lyrics_kikoto/ja/cover.jpg"),
  item(7, "text", "readme.txt"),
  // A lyrics folder the work itself ships.
  item(8, "text", "lyrics/notes/03.lrc"),
];

describe("managed lyrics", () => {
  it("are the lyrics files inside a language folder of Kikoto's lyrics folder", () => {
    expect(managedLyricsLanguage("lyrics_kikoto/zh-hans/mp3/01.vtt")).toBe("zh-cn");
    expect(managedLyricsLanguage("lyrics_kikoto/fallback/01.lrc")).toBe("");
    // A language folder holds lyrics; anything else in it, a file outside the
    // language folders, or a folder the work ships under a familiar name is an
    // ordinary file.
    expect(managedLyricsLanguage("lyrics_kikoto/ja/cover.jpg")).toBeNull();
    expect(managedLyricsLanguage("lyrics_kikoto/01.vtt")).toBeNull();
    expect(managedLyricsLanguage("lyrics/01.lrc")).toBeNull();
    expect(managedLyricsLanguage("lyrics_ja/01.vtt")).toBeNull();
    expect(managedLyricsLanguage("lyrics.txt")).toBeNull();
    expect(managedLyricsLanguage("mp3/lyrics_kikoto/ja/01.vtt")).toBeNull();
    expect(managedLyricsLanguage("lyrics_kikoto/fr/01.vtt")).toBeNull();
    expect(lyricsFileTrackCounts(items).get(4)).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import type { RecordAsset, RecordFolder } from "@/lib/api";

import { folderPathFromChildren, formatPlaybackTime, recordFolderView } from "./recordsModel";

function asset(id: number, name: string, kind: RecordAsset["kind"], streamUrl?: string): RecordAsset {
  return {
    id,
    folderId: 7,
    name,
    relativePath: `Family/Summer Trip/${name}`,
    kind,
    mimeType: "",
    availability: "available",
    streamUrl,
  };
}

function folder(id: number, name: string): RecordFolder {
  return { id, name, relativePath: `Family/Summer Trip/${name}`, depth: 2, childCount: 0, assetCount: 0, artwork: {} };
}

describe("recordFolderView", () => {
  const assets = [
    asset(1, "Day 10 - Hike.mp4", "video", "/s/1"),
    asset(2, "Day 2 - Town.mp4", "video", "/s/2"),
    asset(3, "Day 2 - Town.vtt", "subtitle", "/v/3"),
    asset(4, "beach.jpg", "image", "/s/4"),
    asset(5, "notes.nfo", "metadata"),
    asset(6, "Day 10 - Hike.srt", "subtitle", "/v/6"),
    asset(7, "Day 2 - Town.srt", "subtitle", "/v/7"),
    asset(8, "Poster.JPG", "image", "/s/8"),
    asset(9, "fanart.webp", "image", "/s/9"),
    asset(10, "Day 3.ass", "subtitle"),
    asset(11, "Narration 10.mp3", "audio", "/s/11"),
    asset(12, "Narration 2.flac", "audio", "/s/12"),
    { ...asset(13, "Gone.mp3", "audio", "/s/13"), availability: "missing" as const },
  ];

  it("orders by natural name, lists other files below the tiles, and hides folder artwork", () => {
    const view = recordFolderView([folder(9, "B"), folder(8, "a")], assets);
    expect(view.folders.map((item) => item.name)).toEqual(["a", "B"]);
    expect(view.videos.map((item) => item.id)).toEqual([2, 1]);
    expect(view.photos.map((item) => item.id)).toEqual([4]);
    expect(view.audio.map((item) => item.id)).toEqual([12, 11]);
    expect(view.files.map((item) => item.name)).toEqual([
      "Day 2 - Town.srt",
      "Day 2 - Town.vtt",
      "Day 3.ass",
      "Day 10 - Hike.srt",
      "Narration 2.flac",
      "Narration 10.mp3",
      "notes.nfo",
    ]);
  });

  it("pairs a served same-name subtitle with each video, WebVTT before SubRip", () => {
    const view = recordFolderView([], assets);
    expect([...view.subtitles].map(([video, subtitle]) => [video, subtitle.id])).toEqual([
      [2, 3],
      [1, 6],
    ]);
  });
});

describe("folderPathFromChildren", () => {
  it("reads the listed folder's path from a child, or nothing for an empty folder", () => {
    expect(folderPathFromChildren([], [asset(1, "a.mp4", "video")])).toEqual(["Family", "Summer Trip"]);
    expect(folderPathFromChildren([{ relativePath: "Family" }], [])).toEqual([]);
    expect(folderPathFromChildren([], [])).toBeNull();
  });
});

describe("formatPlaybackTime", () => {
  it("formats minutes and hours", () => {
    expect(formatPlaybackTime(83)).toBe("1:23");
    expect(formatPlaybackTime(3_725)).toBe("1:02:05");
  });
});

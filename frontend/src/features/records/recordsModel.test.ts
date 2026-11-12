import { describe, expect, it } from "vitest";

import type { RecordAsset, RecordFolder } from "@/lib/api";

import { filteredRecordView, folderPathFromChildren, formatPlaybackTime, recordFolderView } from "./recordsModel";

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
  ];

  it("orders by natural name and hides non-media files and folder artwork", () => {
    const view = recordFolderView([folder(9, "B"), folder(8, "a")], assets, "name");
    expect(view.folders.map((item) => item.name)).toEqual(["a", "B"]);
    expect(view.videos.map((item) => item.id)).toEqual([2, 1]);
    expect(view.photos.map((item) => item.id)).toEqual([4]);
    expect(recordFolderView([], assets, "name-desc").videos.map((item) => item.id)).toEqual([1, 2]);
  });

  it("pairs a served same-name subtitle with each video, WebVTT before SubRip", () => {
    const view = recordFolderView([], assets, "name");
    expect([...view.subtitles].map(([video, subtitle]) => [video, subtitle.id])).toEqual([
      [2, 3],
      [1, 6],
    ]);
  });

  it("keeps folders visible under a kind filter", () => {
    const view = recordFolderView([folder(8, "a")], assets, "name");
    const photos = filteredRecordView(view, "photos");
    expect([photos.folders.length, photos.videos.length, photos.photos.length]).toEqual([1, 0, 1]);
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

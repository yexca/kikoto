import { describe, expect, it } from "vitest";

import { buildTree } from "@/features/work-detail/media/mediaTreeModel";
import { mediaDeleteTargetsForFile, sortedFilesDeep } from "@/features/work-detail/dialogs/mediaDeleteTargets";
import type { MediaItem } from "@/lib/api";

import {
  folderLyricsFiles,
  lyricsFileTrackCounts,
  managedLyricsLanguage,
  splitManagedLyrics,
} from "./managedLyricsModel";

const root = "Library/RJ00000000";
const folder = { id: 7, rootPath: root };

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

  it("leaves file management everything except the managed lyrics", () => {
    const tree = buildTree(items, 1, "RJ00000000");
    const { listed, managed } = splitManagedLyrics(tree, root);
    expect(managed.map((file) => file.localPath).sort()).toEqual([
      `${root}/lyrics_kikoto/fallback/notes/02.lrc`,
      `${root}/lyrics_kikoto/zh-hans/mp3/01 Opening.mp3.vtt`,
    ]);
    const listedPaths = sortedFilesDeep(listed).map((file) => file.localPath);
    expect(listedPaths).toHaveLength(6);
    expect(listedPaths).toContain(`${root}/lyrics_kikoto/ja/cover.jpg`);
    expect(listedPaths).toContain(`${root}/lyrics/notes/03.lrc`);
    // A folder that held only managed lyrics is not listed empty.
    expect([...listed.children.keys()].sort()).toEqual(["lyrics", "lyrics_kikoto", "mp3"]);
    expect([...(listed.children.get("lyrics_kikoto")?.children.keys() ?? [])]).toEqual(["ja"]);
    // A tree without managed lyrics is returned as it was given.
    const plain = buildTree([items[0], items[2]], 1, "RJ00000000");
    expect(splitManagedLyrics(plain, root).listed).toBe(plain);
  });
});

describe("managing folder files as lyrics", () => {
  const tree = buildTree(items, 1, "RJ00000000");
  const targets = sortedFilesDeep(tree).flatMap((file) => mediaDeleteTargetsForFile(file, { allowLocalDelete: true }));

  it("offers only the lyrics files of the selection", () => {
    expect(
      folderLyricsFiles(targets, folder)
        .map((file) => file.path)
        .sort(),
    ).toEqual([
      "lyrics/notes/03.lrc",
      "lyrics_kikoto/fallback/notes/02.lrc",
      "lyrics_kikoto/zh-hans/mp3/01 Opening.mp3.vtt",
      "mp3/01 Opening.mp3.vtt",
      "readme.txt",
    ]);
    expect(folderLyricsFiles(targets, { id: 8, rootPath: "Library/RJ00000001" })).toEqual([]);
  });
});

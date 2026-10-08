import { describe, expect, it } from "vitest";

import type { MediaItem, RemoteTrack, WorkFolderLocation, WorkTranslation } from "@/lib/api";

import { lyricsManagerEntries, rebaseLyricsAssignmentDraft } from "./lyricsManagerModel";
import {
  defaultLyricsEditionCode,
  lyricsTargetFolders,
  remoteLyricsFiles,
  remoteLyricsRequest,
  suggestRemoteLyricsMapping,
} from "./remoteLyricsModel";

function remote(
  title: string,
  children: RemoteTrack[] = [],
  type = children.length > 0 ? "folder" : "text",
): RemoteTrack {
  return {
    type,
    title,
    hash: "",
    streamUrl: "",
    downloadUrl: children.length > 0 ? "" : `https://source.example.invalid/${title}`,
    durationSeconds: null,
    sizeBytes: 100,
    cacheLocationId: null,
    cachePath: "",
    cacheAvailable: false,
    localLocationId: null,
    localPath: "",
    localAvailable: false,
    children,
  };
}

function audioItem(id: number, path: string, assignedLyricsMediaItemId: number | null = null): MediaItem {
  return {
    id,
    parentId: null,
    kind: "audio",
    title: path,
    discNo: null,
    trackNo: null,
    durationSeconds: 60,
    sizeBytes: null,
    fingerprint: path,
    progress: null,
    assignedLyricsMediaItemId,
    locations: [
      {
        id: id + 100,
        fileSourceId: 1,
        fileSourceCode: "local",
        fileSourceName: "Local",
        locationType: "local",
        path,
        streamUrl: "",
        downloadUrl: "",
        remoteHash: "",
        sizeBytes: null,
        durationSeconds: 60,
        availability: "available",
        lastCheckedAt: null,
      },
    ],
  };
}

function edition(primaryCode: string, origin: boolean): WorkTranslation {
  return {
    workId: null,
    primaryCode,
    title: "Example Work",
    metadataLanguage: origin ? "JPN" : "CHI_HANS",
    editionLabel: "",
    origin,
    official: !origin,
    translationKind: origin ? "origin" : "official",
    current: origin,
    hasMedia: origin,
    mediaState: origin ? "indexed_available" : "metadata_only",
    localAvailable: origin,
  };
}

describe("remoteLyricsFiles", () => {
  it("lists only downloadable lyrics formats with their tree paths", () => {
    const files = remoteLyricsFiles([
      remote("mp3", [remote("Track1.mp3", [], "audio"), remote("Track1.mp3.vtt")]),
      remote("VTT", [remote("01.lrc"), remote("notes.cue")]),
      remote("readme.txt"),
    ]);
    expect(files.map((file) => [file.path, file.folder])).toEqual([
      ["mp3/Track1.mp3.vtt", "mp3"],
      ["VTT/01.lrc", "VTT"],
      ["readme.txt", ""],
    ]);
  });
});

describe("defaultLyricsEditionCode", () => {
  it("prefers a translated edition because DLsite ships lyrics with translations", () => {
    expect(defaultLyricsEditionCode([edition("RJ00000001", true), edition("RJ00000002", false)], "RJ00000001")).toBe(
      "RJ00000002",
    );
    expect(defaultLyricsEditionCode([edition("RJ00000001", true)], "RJ00000003")).toBe("RJ00000001");
    expect(defaultLyricsEditionCode([], "RJ00000003")).toBe("RJ00000003");
  });
});

describe("lyricsTargetFolders", () => {
  it("offers only active folders that hold the work's audio", () => {
    const folders: WorkFolderLocation[] = [
      {
        id: 1,
        workId: 1,
        fileSourceId: 1,
        rootPath: "Library/RJ00000001",
        role: "external",
        state: "active",
        primary: true,
      },
      {
        id: 2,
        workId: 1,
        fileSourceId: 1,
        rootPath: "Library/RJ00000001 old",
        role: "external",
        state: "active",
        primary: false,
      },
      {
        id: 3,
        workId: 1,
        fileSourceId: 1,
        rootPath: "Library/RJ00000001",
        role: "external",
        state: "ignored",
        primary: false,
      },
    ];
    expect(
      lyricsTargetFolders(folders, [audioItem(1, "Library/RJ00000001/mp3/01.mp3")]).map((folder) => folder.id),
    ).toEqual([1]);
  });
});

describe("suggestRemoteLyricsMapping", () => {
  it("matches names first and aligns translated names by track number", () => {
    const { audio } = lyricsManagerEntries([
      audioItem(1, "Library/RJ00000001/mp3/Track1.Original opening.mp3"),
      audioItem(2, "Library/RJ00000001/mp3/Track2.Original ending.mp3"),
      audioItem(3, "Library/RJ00000001/mp3/Bonus talk.mp3"),
    ]);
    const files = remoteLyricsFiles([
      remote("mp3", [
        remote("Track1.Translated opening.mp3.vtt"),
        remote("Track2.Translated ending.mp3.vtt"),
        remote("Track3.Translated bonus.mp3.vtt"),
      ]),
      remote("extra", [remote("Bonus talk.lrc")]),
    ]);
    expect(Object.fromEntries(suggestRemoteLyricsMapping(audio, files))).toEqual({
      1: "mp3/Track1.Translated opening.mp3.vtt",
      2: "mp3/Track2.Translated ending.mp3.vtt",
      3: "extra/Bonus talk.lrc",
    });
  });
});

describe("remoteLyricsRequest", () => {
  it("downloads every selected file and assigns only selected files", () => {
    const mapping = new Map<number, string | null>([
      [1, "a.vtt"],
      [2, "b.vtt"],
      [3, null],
    ]);
    expect(remoteLyricsRequest(new Set(["a.vtt", "c.vtt"]), mapping, true)).toEqual({
      files: ["a.vtt", "c.vtt"],
      assignments: [{ audioMediaItemId: 1, path: "a.vtt" }],
    });
    expect(remoteLyricsRequest(new Set(["a.vtt"]), mapping, false).assignments).toEqual([]);
  });
});

describe("rebaseLyricsAssignmentDraft", () => {
  it("keeps unsaved edits and takes newly stored assignments elsewhere", () => {
    const before = lyricsManagerEntries([audioItem(1, "w/01.mp3", 10), audioItem(2, "w/02.mp3")]).audio;
    const after = lyricsManagerEntries([audioItem(1, "w/01.mp3", 10), audioItem(2, "w/02.mp3", 21)]).audio;
    const draft = new Map<number, number | null>([
      [1, null],
      [2, null],
    ]);
    expect(Object.fromEntries(rebaseLyricsAssignmentDraft(before, after, draft))).toEqual({ 1: null, 2: 21 });
  });
});

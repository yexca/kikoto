import { describe, expect, it } from "vitest";

import type { FolderEditFile } from "@/features/work-detail/folder-edit/folderEditModel";
import type { LyricsEditItem, LyricsEditPlan, MediaItem, WorkFolderEditSources } from "@/lib/api";

import {
  FOLDER_LYRICS_RESOURCE,
  MANAGED_LYRICS_RESOURCE,
  folderAudio,
  folderLyrics,
  lyricsEditAssignments,
  lyricsEditReadiness,
  lyricsEditRequest,
  lyricsEditResources,
  lyricsEditResult,
} from "./lyricsEditModel";

const root = "Library/RJ00000000";
const target = { workId: 1, folderId: 7, rootPath: root };

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
  item(5, "text", "lyrics_kikoto/ja/02 Ending.vtt"),
  item(6, "image", "lyrics_kikoto/ja/cover.jpg"),
];

const sources = {
  workId: 1,
  primaryCode: "RJ00000000",
  warnings: [],
  editions: [
    {
      workId: 1,
      primaryCode: "RJ00000000",
      metadataLanguage: "JPN",
      editionLabel: "",
      origin: true,
      localRoots: [
        { id: 7, rootPath: root, state: "active" },
        { id: 8, rootPath: "Library/RJ00000000 copy", state: "active" },
      ],
      sources: [{ sourceId: 3, displayName: "Example Remote A", status: "available" }],
    },
    {
      workId: 2,
      primaryCode: "RJ00000001",
      metadataLanguage: "CHI_HANS",
      editionLabel: "",
      origin: false,
      localRoots: [{ id: 9, rootPath: "Library/RJ00000001", state: "active" }],
      sources: [{ sourceId: 3, displayName: "Example Remote A", status: "available" }],
    },
  ],
} as unknown as WorkFolderEditSources;

function planItem(itemKey: string, targetPath: string, changes: Partial<LyricsEditItem> = {}): LyricsEditItem {
  return {
    itemKey,
    path: itemKey,
    kind: "text",
    sizeBytes: 10,
    sourceKind: "folder",
    action: "move_local",
    status: "move_local",
    sourcePath: "",
    localSourcePath: "",
    cachePath: "",
    targetPath: `${root}/${targetPath}`,
    mediaItemId: 0,
    localPaths: [],
    targetExists: false,
    targetConflict: false,
    targetConflictReason: "",
    targetSizeBytes: null,
    originalTargetPath: `${root}/${targetPath}`,
    resolution: "auto",
    remoteSourceId: 0,
    remoteSourceCode: "",
    remoteSourceName: "",
    remotePath: "",
    sourceOptions: [],
    language: "ja-jp",
    ...changes,
  };
}

function plan(planItems: LyricsEditItem[], conflict = 0): LyricsEditPlan {
  return {
    workId: 1,
    folderId: 7,
    folderMode: "copy",
    saveRoot: root,
    items: planItems,
    removals: [],
    summary: { add: planItems.length - conflict, move: 0, copy: 0, download: 0, skip: 0, conflict, remove: 0 },
  };
}

describe("lyrics edit resources", () => {
  const resources = lyricsEditResources(sources, target);

  it("lists the managed lyrics, the folder, the other local folders, and the remote editions", () => {
    expect(resources.map((resource) => [resource.id, resource.kind])).toEqual([
      [MANAGED_LYRICS_RESOURCE, "current"],
      [FOLDER_LYRICS_RESOURCE, "folder"],
      ["local:8", "local"],
      ["local:9", "local"],
      ["remote:3:RJ00000000", "remote"],
      ["remote:3:RJ00000001", "remote"],
    ]);
  });

  it("takes another edition's lyrics to be in its language and never infers the work's own", () => {
    expect(resources.map((resource) => resource.defaultLanguage)).toEqual([
      null,
      null,
      null,
      "zh-cn",
      "ja-jp",
      "zh-cn",
    ]);
  });

  it("splits a folder's lyrics into the managed ones and the others", () => {
    const { managed, loose } = folderLyrics(items, root);
    expect(managed.map((file) => file.path)).toEqual([
      "lyrics_kikoto/zh-hans/mp3/01 Opening.mp3.vtt",
      "lyrics_kikoto/ja/02 Ending.vtt",
    ]);
    expect(loose.map((file) => file.path)).toEqual(["mp3/01 Opening.mp3.vtt"]);
  });
});

describe("lyrics edit request", () => {
  const resources = lyricsEditResources(sources, target);
  const { managed, loose } = folderLyrics(items, root);
  const remoteFiles: FolderEditFile[] = [
    { path: "sub/01 Opening.vtt", name: "01 Opening.vtt", kind: "text", sizeBytes: 5, locationId: null },
  ];
  const files = {
    [MANAGED_LYRICS_RESOURCE]: managed,
    [FOLDER_LYRICS_RESOURCE]: [...loose, ...managed],
    "remote:3:RJ00000001": remoteFiles,
  };

  it("deletes the cleared managed lyrics and adds the selection in each place's language", () => {
    const { request, undeclared } = lyricsEditRequest({
      target,
      resources,
      files,
      selection: {
        [MANAGED_LYRICS_RESOURCE]: new Set(["lyrics_kikoto/zh-hans/mp3/01 Opening.mp3.vtt"]),
        // A file that is being deleted cannot move as well.
        [FOLDER_LYRICS_RESOURCE]: new Set(["mp3/01 Opening.mp3.vtt", "lyrics_kikoto/ja/02 Ending.vtt"]),
        "remote:3:RJ00000001": new Set(["sub/01 Opening.vtt"]),
      },
      languages: { [FOLDER_LYRICS_RESOURCE]: "" },
      decisions: {
        "folder:mp3/01 Opening.mp3.vtt": {
          itemKey: "folder:mp3/01 Opening.mp3.vtt",
          sourceId: 0,
          resolution: "replace",
          targetPath: "",
        },
        "folder:gone.vtt": { itemKey: "folder:gone.vtt", sourceId: 0, resolution: "replace", targetPath: "" },
      },
      folderMode: "move",
    });
    expect(undeclared).toEqual([]);
    expect(request.removeLocationIds).toEqual([105]);
    expect(request.additions).toEqual([
      { kind: "folder", path: "mp3/01 Opening.mp3.vtt", language: "" },
      { kind: "remote", sourceId: 3, remoteCode: "RJ00000001", path: "sub/01 Opening.vtt", language: "zh-cn" },
    ]);
    expect(request.decisions.map((decision) => decision.itemKey)).toEqual(["folder:mp3/01 Opening.mp3.vtt"]);
    expect(request.folderMode).toBe("move");
  });

  it("holds back the files whose language is not declared", () => {
    const selection = {
      [MANAGED_LYRICS_RESOURCE]: new Set(managed.map((file) => file.path)),
      [FOLDER_LYRICS_RESOURCE]: new Set(["mp3/01 Opening.mp3.vtt"]),
    };
    const { request, undeclared } = lyricsEditRequest({
      target,
      resources,
      files,
      selection,
      languages: {},
      decisions: {},
      folderMode: "copy",
    });
    expect(request.additions).toEqual([]);
    expect(undeclared.map((resource) => resource.id)).toEqual([FOLDER_LYRICS_RESOURCE]);
    expect(lyricsEditReadiness({ request, undeclared, plan: null, planCurrent: false })).toBe("undeclared");
  });
});

describe("lyrics edit result", () => {
  const { managed } = folderLyrics(items, root);
  const kept = new Set(["lyrics_kikoto/zh-hans/mp3/01 Opening.mp3.vtt", "lyrics_kikoto/ja/02 Ending.vtt"]);

  it("marks what a planned addition does to the managed lyrics", () => {
    const result = lyricsEditResult(
      managed,
      new Set(["lyrics_kikoto/ja/02 Ending.vtt"]),
      plan([
        // A managed file declared as another language leaves its place.
        planItem("folder:lyrics_kikoto/ja/02 Ending.vtt", "lyrics_kikoto/en/02 Ending.vtt", {
          localSourcePath: `${root}/lyrics_kikoto/ja/02 Ending.vtt`,
        }),
        planItem("remote:3:RJ00000001:new.vtt", "lyrics_kikoto/zh-hans/new.vtt", { action: "cache_download" }),
      ]),
    );
    expect(result.map((entry) => [entry.path, entry.state])).toEqual([
      ["lyrics_kikoto/zh-hans/mp3/01 Opening.mp3.vtt", "remove"],
      ["lyrics_kikoto/ja/02 Ending.vtt", "moved"],
      ["lyrics_kikoto/en/02 Ending.vtt", "add_move"],
      ["lyrics_kikoto/zh-hans/new.vtt", "add_remote"],
    ]);
  });

  it("shows a file that is already there once and a kept file an addition takes the place of as replaced", () => {
    const same = lyricsEditResult(
      managed,
      kept,
      plan([planItem("local:9:a.vtt", "lyrics_kikoto/ja/02 Ending.vtt", { action: "skip" })]),
    );
    expect(same.map((entry) => entry.state)).toEqual(["keep", "same"]);
    const replaced = lyricsEditResult(
      managed,
      kept,
      plan([
        planItem("local:9:a.vtt", "lyrics_kikoto/ja/02 Ending.vtt", { action: "copy_local", resolution: "replace" }),
      ]),
    );
    expect(replaced.map((entry) => [entry.path, entry.state])).toEqual([
      ["lyrics_kikoto/zh-hans/mp3/01 Opening.mp3.vtt", "keep"],
      ["lyrics_kikoto/ja/02 Ending.vtt", "replaced"],
      ["lyrics_kikoto/ja/02 Ending.vtt", "add_local"],
    ]);
  });

  it("waits for a preview without conflicts before an edit that adds files", () => {
    const request = {
      folderId: 7,
      additions: [{ kind: "folder" as const, path: "a.vtt", language: "ja-jp" }],
      removeLocationIds: [],
      decisions: [],
      assignments: [],
      folderMode: "copy" as const,
    };
    const ready = plan([planItem("folder:a.vtt", "lyrics_kikoto/ja/a.vtt")]);
    const blocked = plan(
      [planItem("folder:a.vtt", "lyrics_kikoto/ja/a.vtt", { action: "conflict", targetConflict: true })],
      1,
    );
    expect(lyricsEditReadiness({ request, undeclared: [], plan: null, planCurrent: false })).toBe("refreshing");
    expect(lyricsEditReadiness({ request, undeclared: [], plan: blocked, planCurrent: true })).toBe("blocked");
    expect(lyricsEditReadiness({ request, undeclared: [], plan: ready, planCurrent: true })).toBe("ready");
    expect(
      lyricsEditReadiness({ request: { ...request, additions: [] }, undeclared: [], plan: null, planCurrent: false }),
    ).toBe("idle");
  });
});

describe("lyrics edit assignments", () => {
  const audio = folderAudio(items, root);
  const additions = [
    { kind: "folder" as const, path: "mp3/01 Opening.mp3.vtt", language: "ja-jp" },
    { kind: "remote" as const, sourceId: 3, remoteCode: "RJ00000001", path: "sub/01 Opening.vtt", language: "zh-cn" },
    { kind: "remote" as const, sourceId: 3, remoteCode: "RJ00000001", path: "sub/02 Ending.vtt", language: "zh-cn" },
  ];

  it("suggests the added files per language and leaves a track its lyrics in that language", () => {
    expect(lyricsEditAssignments({ audio, additions, plan: null })).toEqual([
      { audioMediaItemId: 1, itemKey: "folder:mp3/01 Opening.mp3.vtt" },
      // The first track already has Simplified Chinese lyrics.
      { audioMediaItemId: 2, itemKey: "remote:3:RJ00000001:sub/02 Ending.vtt" },
    ]);
  });

  it("does not assign a file the plan leaves out", () => {
    const left = plan([
      planItem("remote:3:RJ00000001:sub/02 Ending.vtt", "lyrics_kikoto/zh-hans/sub/02 Ending.vtt", {
        action: "exclude",
      }),
    ]);
    expect(lyricsEditAssignments({ audio, additions, plan: left }).map((assignment) => assignment.itemKey)).toEqual([
      "folder:mp3/01 Opening.mp3.vtt",
    ]);
  });
});

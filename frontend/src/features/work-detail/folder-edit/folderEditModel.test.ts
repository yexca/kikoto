import { describe, expect, it } from "vitest";

import type {
  ComposedFetchPlan,
  MediaItem,
  RemoteFetchEdition,
  WorkFolderEditItem,
  WorkFolderEditPlan,
  WorkFolderEditSources,
} from "@/lib/api";
import {
  CURRENT_FOLDER_RESOURCE,
  buildFolderEditTree,
  conflictResolutions,
  fetchComposeReadiness,
  fetchComposeRequest,
  fetchComposeResources,
  fetchComposeResult,
  folderEditMerges,
  folderEditReadiness,
  folderEditRemoteResource,
  folderEditRequest,
  folderEditResourceChanges,
  folderEditResources,
  folderEditResult,
  localFolderFiles,
  type FolderEditFile,
} from "./folderEditModel";

const target = { workId: 1, folderId: 11, rootPath: "Library/RJ00000001" };

function edition(overrides: Partial<RemoteFetchEdition>): RemoteFetchEdition {
  return {
    workId: 1,
    primaryCode: "RJ00000001",
    title: "Example Work 1",
    metadataLanguage: "JPN",
    editionLabel: "",
    translationKind: "origin",
    classificationSource: "",
    makerId: "",
    originMakerId: "",
    origin: true,
    localRoots: [],
    sources: [],
    ...overrides,
  };
}

function remoteSource(sourceId: number, status: "available" | "not_found") {
  return {
    sourceId,
    sourceCode: "example_remote_a",
    displayName: "Example Remote A",
    status,
    remoteId: "",
    primaryCode: "",
    title: "",
    coverUrl: "",
    workId: null,
    hasRemote: status === "available",
    hasTracked: false,
    hasCache: false,
    hasLocal: false,
    error: "",
    elapsedMs: 0,
  };
}

const sources: WorkFolderEditSources = {
  workId: 1,
  primaryCode: "RJ00000001",
  warnings: [],
  editions: [
    edition({
      localRoots: [
        {
          id: 11,
          fileSourceId: 1,
          rootPath: "Library/RJ00000001",
          role: "external",
          state: "active",
          availability: "available",
          primary: true,
        },
        {
          id: 12,
          fileSourceId: 1,
          rootPath: "Other/RJ00000001",
          role: "alternate",
          state: "active",
          availability: "available",
          primary: false,
        },
        {
          id: 13,
          fileSourceId: 1,
          rootPath: "Gone/RJ00000001",
          role: "alternate",
          state: "ignored",
          availability: "available",
          primary: false,
        },
      ],
      sources: [remoteSource(7, "available")],
    }),
    edition({
      workId: 2,
      primaryCode: "RJ00000002",
      metadataLanguage: "CHI_HANS",
      translationKind: "official",
      origin: false,
      localRoots: [
        {
          id: 21,
          fileSourceId: 1,
          rootPath: "Library/RJ00000002",
          role: "external",
          state: "active",
          availability: "available",
          primary: true,
        },
      ],
      sources: [remoteSource(7, "available"), remoteSource(8, "not_found")],
    }),
  ],
};

function file(path: string, locationId: number | null = null, sizeBytes = 10): FolderEditFile {
  return { path, name: path.split("/").pop() ?? path, kind: "audio", sizeBytes, locationId };
}

function planItem(overrides: Partial<WorkFolderEditItem>): WorkFolderEditItem {
  return {
    itemKey: "local:21:wav/01.wav",
    path: "wav/01.wav",
    kind: "audio",
    sizeBytes: 10,
    sourceKind: "local",
    action: "copy_local",
    status: "copy_local",
    sourcePath: "",
    localSourcePath: "",
    cachePath: "",
    targetPath: "Library/RJ00000001/wav/01.wav",
    mediaItemId: 0,
    localPaths: [],
    targetExists: false,
    targetConflict: false,
    targetConflictReason: "",
    targetSizeBytes: null,
    originalTargetPath: "Library/RJ00000001/wav/01.wav",
    resolution: "auto",
    remoteSourceId: 0,
    remoteSourceCode: "",
    remoteSourceName: "",
    remotePath: "",
    sourceOptions: [],
    ...overrides,
  };
}

function plan(items: WorkFolderEditItem[], conflict = 0): WorkFolderEditPlan {
  return {
    workId: 1,
    primaryCode: "RJ00000001",
    folderId: 11,
    saveRoot: "Library/RJ00000001",
    items,
    removals: [],
    summary: {
      add: items.length - conflict,
      copy: 0,
      download: 0,
      skip: 0,
      conflict,
      remove: 0,
      move: 0,
      folders: 0,
      merge: 0,
      mergeFiles: 0,
      lyrics: 0,
      addBytes: 0,
      removeBytes: 0,
    },
  };
}

describe("folder edit resources", () => {
  const resources = folderEditResources(sources, target);

  it("lists the edited folder, the family's other active folders, then the available remote editions", () => {
    expect(resources.map((resource) => resource.id)).toEqual([
      CURRENT_FOLDER_RESOURCE,
      "local:12",
      "local:21",
      "remote:7:RJ00000001",
      "remote:7:RJ00000002",
    ]);
  });

  it("keeps a folder on an offline storage pool in the list, marked offline", () => {
    const offline = {
      ...sources,
      editions: sources.editions.map((edition) => ({
        ...edition,
        localRoots: edition.localRoots.map((root) =>
          root.id === 21 ? { ...root, availability: "offline" as const } : root,
        ),
      })),
    };
    const listed = folderEditResources(offline, target);
    expect(listed.find((resource) => resource.id === "local:21")?.offline).toBe(true);
    expect(listed.find((resource) => resource.id === "local:12")?.offline).toBe(false);
  });

  it("merges no folder a check found offline", () => {
    const checked = resources.map((resource) =>
      resource.id === "local:21" ? { ...resource, offline: true } : resource,
    );
    expect(folderEditMerges(checked, new Set([12, 21]))).toEqual([12]);
  });

  it("does not list a folder whose path is the edited folder's in another letter case", () => {
    const sameFolder = {
      ...sources,
      editions: sources.editions.map((edition) =>
        edition.workId === 1
          ? { ...edition, localRoots: edition.localRoots.map((root) => ({ ...root, rootPath: "library/rj00000001" })) }
          : edition,
      ),
    };
    expect(folderEditResources(sameFolder, target).map((resource) => resource.id)).not.toContain("local:12");
  });

  it("opens a Fetch on the source's edition, or on any edition the source offers", () => {
    expect(folderEditRemoteResource(resources, 7, "rj00000002")?.id).toBe("remote:7:RJ00000002");
    expect(folderEditRemoteResource(resources, 7, "RJ00000009")?.id).toBe("remote:7:RJ00000001");
    expect(folderEditRemoteResource(resources, 9, "RJ00000001")).toBeNull();
  });
});

describe("folder edit files", () => {
  it("lists a folder's available local files by their path inside it", () => {
    const location = { fileSourceId: 1, fileSourceCode: "", fileSourceName: "", streamUrl: "", downloadUrl: "" };
    const meta = { remoteHash: "", durationSeconds: null, lastCheckedAt: null };
    const items = [
      {
        id: 1,
        kind: "audio",
        locations: [
          {
            ...location,
            ...meta,
            id: 5,
            locationType: "local",
            path: "Library/RJ00000001/mp3/01.mp3",
            sizeBytes: 3,
            availability: "available",
          },
          {
            ...location,
            ...meta,
            id: 6,
            locationType: "local",
            path: "Other/RJ00000001/mp3/01.mp3",
            sizeBytes: 3,
            availability: "available",
          },
          {
            ...location,
            ...meta,
            id: 7,
            locationType: "cache",
            path: "Library/RJ00000001/mp3/02.mp3",
            sizeBytes: 3,
            availability: "available",
          },
          {
            ...location,
            ...meta,
            id: 8,
            locationType: "local",
            path: "Library/RJ00000001/mp3/03.mp3",
            sizeBytes: 3,
            availability: "unavailable",
          },
        ],
      },
    ] as unknown as MediaItem[];
    expect(localFolderFiles(items, "/Library/RJ00000001/")).toEqual([
      { path: "mp3/01.mp3", name: "01.mp3", kind: "audio", sizeBytes: 3, locationId: 5 },
    ]);
  });

  it("groups files into their folders", () => {
    const tree = buildFolderEditTree([file("a/b/1.mp3"), file("a/2.mp3"), file("3.mp3")]);
    expect(tree.files.map((entry) => entry.path)).toEqual(["3.mp3"]);
    expect(tree.children.get("a")?.files.map((entry) => entry.path)).toEqual(["a/2.mp3"]);
    expect(tree.children.get("a")?.children.get("b")?.path).toBe("a/b");
  });
});

describe("folder edit request", () => {
  const resources = folderEditResources(sources, target);
  const files = {
    [CURRENT_FOLDER_RESOURCE]: [file("mp3/01.mp3", 5), file("mp3/02.mp3", 6)],
    "local:21": [file("wav/01.wav"), file("wav/02.wav")],
    "remote:7:RJ00000002": [file("sub/01.vtt")],
  };
  const selection = {
    [CURRENT_FOLDER_RESOURCE]: new Set(["mp3/01.mp3"]),
    "local:21": new Set(["wav/01.wav"]),
    "remote:7:RJ00000002": new Set(["sub/01.vtt"]),
  };

  it("adds the files selected elsewhere and removes the files cleared in the edited folder", () => {
    const stale = { itemKey: "local:21:wav/02.wav", sourceId: 0, resolution: "replace" as const, targetPath: "" };
    const kept = { itemKey: "local:21:wav/01.wav", sourceId: 0, resolution: "keep_both" as const, targetPath: "" };
    const request = folderEditRequest({ target, resources, files, selection, decisions: { stale, kept } });
    expect(request).toEqual({
      folderId: 11,
      additions: [
        { kind: "local", folderId: 21, path: "wav/01.wav" },
        { kind: "remote", sourceId: 7, remoteCode: "RJ00000002", path: "sub/01.vtt" },
      ],
      removeLocationIds: [6],
      decisions: [kept],
    });
  });

  it("counts removed files for the edited folder and added files for any other resource", () => {
    expect(
      folderEditResourceChanges(resources[0], files[CURRENT_FOLDER_RESOURCE], selection[CURRENT_FOLDER_RESOURCE]),
    ).toBe(1);
    expect(folderEditResourceChanges(resources[2], files["local:21"], selection["local:21"])).toBe(1);
    expect(folderEditResourceChanges(resources[1], undefined, undefined)).toBe(0);
  });

  it("is ready to remove without a preview, and waits for a current preview without conflicts to add", () => {
    const removeOnly = { folderId: 11, additions: [], removeLocationIds: [6], decisions: [] };
    const adding = { ...removeOnly, additions: [{ kind: "local" as const, folderId: 21, path: "wav/01.wav" }] };
    expect(
      folderEditReadiness({ request: { ...removeOnly, removeLocationIds: [] }, plan: null, planCurrent: false }),
    ).toBe("idle");
    expect(folderEditReadiness({ request: removeOnly, plan: null, planCurrent: false })).toBe("ready");
    expect(folderEditReadiness({ request: adding, plan: null, planCurrent: false })).toBe("refreshing");
    expect(folderEditReadiness({ request: adding, plan: plan([planItem({})]), planCurrent: false })).toBe("refreshing");
    expect(folderEditReadiness({ request: adding, plan: plan([planItem({})], 1), planCurrent: true })).toBe("blocked");
    expect(folderEditReadiness({ request: adding, plan: plan([planItem({})]), planCurrent: true })).toBe("ready");
  });
});

describe("folder edit result", () => {
  const current = [file("mp3/01.mp3", 5), file("mp3/02.mp3", 6), file("cover.jpg", 7)];
  const states = (entries: ReturnType<typeof folderEditResult>) =>
    Object.fromEntries(entries.map((entry) => [`${entry.key}`, entry.state]));

  it("shows kept, removed, and added files of the final folder", () => {
    const entries = folderEditResult(current, new Set(["mp3/01.mp3", "cover.jpg"]), plan([planItem({})]));
    expect(states(entries)).toEqual({
      "current:mp3/01.mp3": "keep",
      "current:mp3/02.mp3": "remove",
      "current:cover.jpg": "keep",
      "local:21:wav/01.wav": "add_local",
    });
    expect(entries.find((entry) => entry.key === "local:21:wav/01.wav")?.path).toBe("wav/01.wav");
  });

  it("marks a file that is already there instead of listing it twice", () => {
    const same = planItem({ action: "skip", targetPath: "Library/RJ00000001/mp3/01.mp3" });
    expect(states(folderEditResult(current, new Set(["mp3/01.mp3"]), plan([same])))).toMatchObject({
      "current:mp3/01.mp3": "same",
    });
    expect(folderEditResult(current, new Set(["mp3/01.mp3"]), plan([same]))).toHaveLength(3);
  });

  it("matches a file whose path differs only in Unicode composition, as the server does", () => {
    const composed = [file("Café.mp3", 8)];
    const same = planItem({ action: "skip", targetPath: "Library/RJ00000001/café.mp3" });
    expect(states(folderEditResult(composed, new Set(["Café.mp3"]), plan([same])))).toEqual({
      "current:Café.mp3": "same",
    });
  });

  it("marks a kept file an addition replaces, and keeps conflicts and exclusions reviewable", () => {
    const replace = planItem({ itemKey: "a", action: "cache_download", targetPath: "Library/RJ00000001/MP3/01.mp3" });
    const conflict = planItem({
      itemKey: "b",
      action: "conflict",
      targetConflict: true,
      targetPath: "Library/RJ00000001/cover.jpg",
    });
    const excluded = planItem({ itemKey: "c", action: "exclude", targetPath: "Library/RJ00000001/extra.txt" });
    const all = new Set(current.map((entry) => entry.path));
    expect(states(folderEditResult(current, all, plan([replace, conflict, excluded], 1)))).toEqual({
      "current:mp3/01.mp3": "replaced",
      "current:mp3/02.mp3": "keep",
      "current:cover.jpg": "keep",
      a: "add_remote",
      b: "conflict",
      c: "excluded",
    });
  });
});

describe("folder edit conflicts", () => {
  it("never offers to replace a folder, or to create anything below a blocking file", () => {
    expect(conflictResolutions({})).toContain("replace");
    expect(conflictResolutions({ targetBlock: "not_a_file" })).toEqual(["auto", "keep_local", "keep_both", "rename"]);
    expect(conflictResolutions({ targetBlock: "blocked_path" })).toEqual(["auto", "keep_local", "rename"]);
  });
});

describe("folder edit lyrics", () => {
  const resources = folderEditResources(sources, target);

  it("adds a file with a declared language as lyrics, and any other file at its own path", () => {
    const request = folderEditRequest({
      target,
      resources,
      files: { "remote:7:RJ00000002": [file("sub/01.vtt"), file("sub/02.vtt")] },
      selection: { "remote:7:RJ00000002": new Set(["sub/01.vtt", "sub/02.vtt"]) },
      lyrics: { "remote:7:RJ00000002": { "sub/01.vtt": "zh-cn" } },
      decisions: {},
    });
    expect(request.additions).toEqual([
      { kind: "remote", sourceId: 7, remoteCode: "RJ00000002", path: "sub/01.vtt", language: "zh-cn" },
      { kind: "remote", sourceId: 7, remoteCode: "RJ00000002", path: "sub/02.vtt" },
    ]);
  });
});

describe("fetch into a new folder", () => {
  const fetch = { sourceId: 8, sourceName: "Example Remote B", remoteCode: "RJ00000001", editionCode: "RJ00000001" };
  const preparation = {
    requestedCode: "RJ00000001",
    canonicalCode: "RJ00000001",
    metadataStatus: "complete" as const,
    warnings: [],
    editions: sources.editions,
  };

  it("lists the fetched edition on its source first, then the other remote editions, then the local folders", () => {
    expect(fetchComposeResources(preparation, fetch).map((resource) => resource.id)).toEqual([
      "remote:8:RJ00000001",
      "remote:7:RJ00000001",
      "remote:7:RJ00000002",
      "local:11",
      "local:12",
      "local:21",
    ]);
    // Before the first preview reports the family, the fetched edition is the only place.
    expect(fetchComposeResources(null, fetch).map((resource) => resource.id)).toEqual(["remote:8:RJ00000001"]);
  });

  it("fetches the edition's plain files and adds everything else once the folder exists", () => {
    const resources = fetchComposeResources(preparation, fetch);
    const fetchedDecision = {
      itemKey: "remote:mp3/01.mp3",
      sourceId: 0,
      resolution: "exclude" as const,
      targetPath: "",
    };
    const followDecision = {
      itemKey: "remote:7:RJ00000002:sub/01.vtt",
      sourceId: 0,
      resolution: "keep_both" as const,
      targetPath: "",
    };
    const request = fetchComposeRequest({
      fetch,
      resources,
      files: {
        "remote:8:RJ00000001": [file("mp3/01.mp3"), file("mp3/01.lrc")],
        "remote:7:RJ00000002": [file("sub/01.vtt")],
        "local:21": [file("wav/01.wav")],
      },
      selection: {
        "remote:8:RJ00000001": new Set(["mp3/01.mp3", "mp3/01.lrc"]),
        "remote:7:RJ00000002": new Set(["sub/01.vtt"]),
        "local:21": new Set(["wav/01.wav"]),
      },
      lyrics: { "remote:8:RJ00000001": { "mp3/01.lrc": "ja-jp" }, "remote:7:RJ00000002": { "sub/01.vtt": "zh-cn" } },
      decisions: { fetchedDecision, followDecision },
      minFreeBytes: 1,
    });
    expect(request).toEqual({
      paths: ["mp3/01.mp3"],
      decisions: [fetchedDecision],
      minFreeBytes: 1,
      followUp: {
        additions: [
          { kind: "remote", sourceId: 8, remoteCode: "RJ00000001", path: "mp3/01.lrc", language: "ja-jp" },
          { kind: "remote", sourceId: 7, remoteCode: "RJ00000002", path: "sub/01.vtt", language: "zh-cn" },
          { kind: "local", folderId: 21, path: "wav/01.wav" },
        ],
        decisions: [followDecision],
      },
    });
  });

  it("shows both parts in the new folder and starts only without conflicts in either", () => {
    const fetched = planItem({
      itemKey: "remote:mp3/01.mp3",
      sourceKind: "remote",
      action: "cache_download",
      targetPath: "Fetch/RJ00000001/mp3/01.mp3",
    });
    const lyrics = planItem({
      itemKey: "remote:7:RJ00000002:sub/01.vtt",
      sourceKind: "remote",
      kind: "text",
      action: "cache_download",
      targetPath: "Fetch/RJ00000001/lyrics_kikoto/zh-hans/sub/01.vtt",
      language: "zh-cn",
    });
    const composed = (conflict: number): ComposedFetchPlan => ({
      sourceId: 8,
      primaryCode: "RJ00000001",
      saveRoot: "Fetch/RJ00000001",
      fetchRoot: { rootPath: "", status: "ready", conflict: false, message: "" },
      localFiles: [],
      items: [fetched],
      summary: { total: 1, skipExisting: 0, cacheHit: 0, cacheDownload: 1, promote: 1, conflict: 0 },
      preparation,
      followUp: { ...plan([lyrics], conflict), saveRoot: "Fetch/RJ00000001" },
    });
    expect(fetchComposeResult(composed(0)).map((entry) => [entry.path, entry.state])).toEqual([
      ["mp3/01.mp3", "add_remote"],
      ["lyrics_kikoto/zh-hans/sub/01.vtt", "add_remote"],
    ]);
    const request = { paths: ["mp3/01.mp3"], decisions: [], minFreeBytes: 1 };
    const idle = { ...request, paths: [] };
    expect(fetchComposeReadiness({ request: idle, plan: composed(0), planCurrent: true })).toBe("idle");
    expect(fetchComposeReadiness({ request, plan: composed(0), planCurrent: false })).toBe("refreshing");
    expect(fetchComposeReadiness({ request, plan: composed(1), planCurrent: true })).toBe("blocked");
    expect(fetchComposeReadiness({ request, plan: composed(0), planCurrent: true })).toBe("ready");
  });
});

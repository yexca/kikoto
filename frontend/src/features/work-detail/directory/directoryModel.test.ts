import { describe, expect, it } from "vitest";

import type { TreeNode, TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import {
  activeTrackFolderPath,
  cursorInTree,
  folderNavigatorRows,
  folderSections,
  initialFolderNavigatorExpansion,
  trackListeningState,
  treeTrackProgress,
} from "./directoryModel";

function file(id: number, title: string, kind = "audio", overrides: Partial<TreeTrack> = {}): TreeTrack {
  return {
    mediaItemId: id,
    locationId: id,
    title,
    baseName: title.replace(/\.[^.]+$/, ""),
    sourcePath: title,
    kind,
    folderPath: "",
    locationType: "local",
    streamUrl: `/api/media/${id}/stream`,
    downloadUrl: "",
    assetUrl: "",
    sizeBytes: 1024,
    durationSeconds: kind === "audio" ? 600 : null,
    hasAudio: null,
    availability: "available",
    cacheLocationId: null,
    cachePath: "",
    cacheAvailable: false,
    cacheStreamUrl: "",
    localLocationId: id,
    localPath: title,
    localAvailable: true,
    progress: null,
    locations: [],
    ...overrides,
  };
}

/** Builds a tree from `{ name: subtree }` objects whose `files` key lists the folder's files. */
type Spec = { files?: TreeTrack[]; [folder: string]: Spec | TreeTrack[] | undefined };

function tree(spec: Spec, name = "", path = ""): TreeNode {
  const node: TreeNode = { name, path, children: new Map(), files: spec.files ?? [] };
  for (const [key, value] of Object.entries(spec)) {
    if (key === "files" || !value || Array.isArray(value)) continue;
    const childPath = path ? `${path}/${key}` : key;
    node.children.set(key, tree(value, key, childPath));
  }
  return node;
}

function visibleRows(root: TreeNode, expanded: string[]) {
  return folderNavigatorRows(root, new Set(expanded)).map((row) => ({
    label: row.labelParts.join(" / ") || "(root)",
    depth: row.depth,
    path: row.path.join("/"),
  }));
}

describe("folder navigator rows", () => {
  it("merges a wrapper folder into the root row and lists its folders at the root level", () => {
    const root = tree({
      "Example Work": {
        Main: { files: [file(1, "01.mp3")] },
        Bonus: { files: [file(2, "bonus.mp3")] },
      },
    });

    expect(visibleRows(root, [])).toEqual([
      { label: "Example Work", depth: 0, path: "Example Work" },
      { label: "Bonus", depth: 0, path: "Example Work/Bonus" },
      { label: "Main", depth: 0, path: "Example Work/Main" },
    ]);
  });

  it("merges single-folder chains below the root and hides the children of collapsed folders", () => {
    const root = tree({
      files: [file(1, "readme.txt", "text")],
      Audio: { mp3: { "With SE": { files: [file(2, "01.mp3")] }, "Without SE": { files: [file(3, "01.mp3")] } } },
      Images: { files: [file(4, "cover.jpg", "image")] },
    });

    expect(visibleRows(root, [])).toEqual([
      { label: "(root)", depth: 0, path: "" },
      { label: "Audio / mp3", depth: 0, path: "Audio/mp3" },
      { label: "Images", depth: 0, path: "Images" },
    ]);
    expect(visibleRows(root, ["Audio/mp3"])).toEqual([
      { label: "(root)", depth: 0, path: "" },
      { label: "Audio / mp3", depth: 0, path: "Audio/mp3" },
      { label: "With SE", depth: 1, path: "Audio/mp3/With SE" },
      { label: "Without SE", depth: 1, path: "Audio/mp3/Without SE" },
      { label: "Images", depth: 0, path: "Images" },
    ]);
  });

  it("opens a small tree completely and a large tree only toward the focused folders", () => {
    const small = tree({ A: { B: { files: [file(1, "1.mp3")] } }, C: { files: [file(2, "2.mp3")] } });
    expect([...initialFolderNavigatorExpansion(small, [])]).toEqual(["A"]);

    const large: Spec = {};
    for (let index = 0; index < 13; index += 1) {
      large[`Folder ${index}`] = { Inner: { files: [file(index + 1, `${index}.mp3`)] } };
    }
    const expansion = initialFolderNavigatorExpansion(tree(large), [["Folder 3", "Inner"], null]);
    expect([...expansion]).toEqual(["Folder 3", "Folder 3/Inner"]);
  });
});

describe("folder contents", () => {
  it("groups playable tracks, images, text, and everything else in folder order", () => {
    const unavailable = file(5, "missing.mp3", "audio", { availability: "unavailable" });
    const sections = folderSections([
      file(1, "01.mp3"),
      file(2, "cover.jpg", "image"),
      file(3, "notes.txt", "text"),
      file(4, "archive.zip", "file"),
      unavailable,
      file(6, "pv.mp4", "video"),
    ]);

    expect(sections.tracks.map((track) => track.title)).toEqual(["01.mp3", "pv.mp4"]);
    expect(sections.images.map((track) => track.title)).toEqual(["cover.jpg"]);
    expect(sections.documents.map((track) => track.title)).toEqual(["notes.txt"]);
    expect(sections.others.map((track) => track.title)).toEqual(["archive.zip", "missing.mp3"]);
  });

  it("finds the folder of the playing file the same way rows mark it active", () => {
    const keyed = file(3, "02.mp3", "audio", { playbackKey: "remote:2" });
    const root = tree({ Main: { files: [file(1, "01.mp3")] }, Remote: { files: [keyed] } });

    expect(activeTrackFolderPath(root, 1, null)).toEqual(["Main"]);
    expect(activeTrackFolderPath(root, 3, null)).toBeNull();
    expect(activeTrackFolderPath(root, null, "remote:2")).toEqual(["Remote"]);
    expect(activeTrackFolderPath(root, null, null)).toBeNull();
  });
});

describe("track listening state", () => {
  const loadedCursor = { positionSeconds: 120, durationSeconds: 600, completed: false, lastPlayedAt: null };

  it("moves the single resume marker to the track of a newer cursor in the same tree", () => {
    const first = file(1, "01.mp3", "audio", { progress: loadedCursor });
    const second = file(2, "02.mp3");
    const root = tree({ files: [first, second] });
    const newer = { ...loadedCursor, mediaItemId: 2, positionSeconds: 30 };

    expect(treeTrackProgress(first, cursorInTree(root, null))).toBe(loadedCursor);
    expect(treeTrackProgress(first, cursorInTree(root, newer))).toBeNull();
    expect(treeTrackProgress(second, cursorInTree(root, newer))?.positionSeconds).toBe(30);
    // A cursor saved for another work leaves this tree as it was loaded.
    expect(cursorInTree(root, { ...newer, mediaItemId: 99 })).toBeNull();
  });

  it("reports finished tracks, time left, and ignores accidental starts", () => {
    expect(trackListeningState(null, 600)).toEqual({ kind: "unplayed" });
    expect(trackListeningState({ ...loadedCursor, positionSeconds: 3 }, 600)).toEqual({ kind: "unplayed" });
    expect(trackListeningState({ ...loadedCursor, completed: true }, 600)).toEqual({ kind: "played" });
    expect(trackListeningState(loadedCursor, null)).toEqual({
      kind: "inProgress",
      positionSeconds: 120,
      fraction: 0.2,
      remainingSeconds: 480,
    });
    expect(trackListeningState({ ...loadedCursor, durationSeconds: null }, null)).toEqual({
      kind: "inProgress",
      positionSeconds: 120,
      fraction: null,
      remainingSeconds: null,
    });
  });
});

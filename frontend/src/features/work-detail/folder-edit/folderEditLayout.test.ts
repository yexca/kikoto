import { describe, expect, it } from "vitest";

import {
  deleteFolder,
  emptyFolderEditLayout,
  folderHasContent,
  folderNameError,
  moveFilesTo,
  moveFolderTo,
  placeFilesBelow,
  renameFolder,
  type FolderEditLayout,
  type FolderEditPlaced,
} from "./folderEditLayout";
import {
  CURRENT_FOLDER_RESOURCE,
  currentFileKey,
  fetchComposeRequest,
  fetchItemKey,
  folderEditRequest,
  folderEditResult,
  type FolderEditFile,
  type FolderEditResource,
} from "./folderEditModel";

const files: FolderEditPlaced[] = [
  { key: "a", path: "mp3/01.mp3" },
  { key: "b", path: "mp3/02.mp3" },
  { key: "c", path: "cover.jpg" },
  { key: "d", path: "Bonus/01.mp3" },
];

/** Where each file is once the layout applies. */
function paths(layout: FolderEditLayout, placed = files) {
  return Object.fromEntries(placed.map((file) => [file.key, layout.placements[file.key] ?? file.path]));
}

describe("folder edit layout", () => {
  it("moves files into a folder and numbers a name the folder already holds", () => {
    const layout = moveFilesTo(emptyFolderEditLayout, files, ["a", "c"], "Bonus");
    expect(paths(layout)).toMatchObject({ a: "Bonus/01 (2).mp3", c: "Bonus/cover.jpg", d: "Bonus/01.mp3" });
  });

  it("moves a folder with its contents, and never into itself", () => {
    const layout = moveFolderTo(emptyFolderEditLayout, files, "mp3", "Bonus");
    expect(paths(layout)).toMatchObject({ a: "Bonus/mp3/01.mp3", b: "Bonus/mp3/02.mp3" });
    const nested = moveFolderTo(layout, files, "Bonus", "Bonus/mp3");
    expect(nested).toBe(layout);
  });

  it("combines a folder with one of the same name at its new place", () => {
    const placed = [...files, { key: "e", path: "Disc/Bonus/01.mp3" }];
    const layout = moveFolderTo(emptyFolderEditLayout, placed, "Bonus", "Disc");
    expect(paths(layout, placed)).toMatchObject({ d: "Disc/Bonus/01 (2).mp3", e: "Disc/Bonus/01.mp3" });
  });

  it("deletes a folder by moving what it holds up one level", () => {
    const placed = [...files, { key: "e", path: "mp3/cover.jpg" }];
    const layout = deleteFolder({ placements: {}, folders: ["mp3/Empty"] }, placed, "mp3");
    expect(paths(layout, placed)).toMatchObject({ a: "01.mp3", b: "02.mp3", e: "cover (2).jpg", c: "cover.jpg" });
    expect(layout.folders).toEqual(["Empty"]);
  });

  it("renames a folder and keeps what it holds inside", () => {
    const layout = renameFolder(emptyFolderEditLayout, files, "mp3", "Disc 1");
    expect(paths(layout)).toMatchObject({ a: "Disc 1/01.mp3", b: "Disc 1/02.mp3" });
  });

  it("places files dragged in from another place below the folder they are dropped on", () => {
    const arriving = [{ key: "x", path: "Translated/01.mp3" }];
    const layout = placeFilesBelow(emptyFolderEditLayout, files, arriving, "Bonus");
    expect(layout.placements.x).toBe("Bonus/Translated/01.mp3");
  });

  it("refuses folder names that are empty, contain a slash, are taken, or are the lyrics folder", () => {
    expect(folderNameError(files, [], "", " ")).toBe("empty");
    expect(folderNameError(files, [], "", "a/b")).toBe("invalid");
    expect(folderNameError(files, [], "", "MP3")).toBe("taken");
    expect(folderNameError(files, [], "", "cover.jpg")).toBe("taken");
    expect(folderNameError(files, [], "", "lyrics_kikoto")).toBe("reserved");
    expect(folderNameError(files, [], "", "mp3", "mp3")).toBeNull();
    expect(folderNameError(files, ["Extras"], "", "extras")).toBe("taken");
  });

  it("knows whether a folder holds anything", () => {
    expect(folderHasContent(files, [], "mp3")).toBe(true);
    expect(folderHasContent(files, ["Empty"], "Empty")).toBe(false);
    expect(folderHasContent(files, ["Empty", "Empty/Inner"], "Empty")).toBe(true);
  });
});

const current: FolderEditFile[] = [
  { path: "mp3/01.mp3", name: "01.mp3", kind: "audio", sizeBytes: 10, locationId: 101 },
  { path: "mp3/02.mp3", name: "02.mp3", kind: "audio", sizeBytes: 10, locationId: 102 },
];
const other: FolderEditResource = {
  id: "local:12",
  kind: "local",
  editionCode: "RJ00000002",
  language: "",
  origin: false,
  folderId: 12,
  workId: 2,
  rootPath: "Library/RJ00000002",
  sourceId: 0,
  sourceName: "",
};
const currentResource: FolderEditResource = {
  ...other,
  id: CURRENT_FOLDER_RESOURCE,
  kind: "current",
  folderId: 11,
  workId: 1,
};

describe("an arranged folder edit", () => {
  const layout: FolderEditLayout = {
    placements: {
      [currentFileKey("mp3/01.mp3")]: "Disc 1/01.mp3",
      "local:12:notes.txt": "Extras/notes.txt",
      "local:12:lyrics.vtt": "Extras/lyrics.vtt",
    },
    folders: ["Empty"],
  };
  const request = folderEditRequest({
    target: { workId: 1, folderId: 11, rootPath: "Library/RJ00000001" },
    resources: [currentResource, other],
    files: {
      [CURRENT_FOLDER_RESOURCE]: current,
      "local:12": [
        { path: "notes.txt", name: "notes.txt", kind: "text", sizeBytes: 3, locationId: 201 },
        { path: "lyrics.vtt", name: "lyrics.vtt", kind: "text", sizeBytes: 3, locationId: 202 },
      ],
    },
    selection: {
      [CURRENT_FOLDER_RESOURCE]: new Set(["mp3/01.mp3", "mp3/02.mp3"]),
      "local:12": new Set(["notes.txt", "lyrics.vtt"]),
    },
    lyrics: { "local:12": { "lyrics.vtt": "jpn" } },
    decisions: {},
    layout,
    merges: [12],
  });

  it("moves placed files, places additions, creates folders, and merges places", () => {
    expect(request.moves).toEqual([{ locationId: 101, path: "Disc 1/01.mp3" }]);
    expect(request.additions).toEqual([
      { kind: "local", folderId: 12, path: "notes.txt", targetPath: "Extras/notes.txt" },
      // A lyrics role decides where the file goes, not a placement.
      { kind: "local", folderId: 12, path: "lyrics.vtt", language: "jpn" },
    ]);
    expect(request.folders).toEqual(["Empty"]);
    expect(request.mergeFolderIds).toEqual([12]);
  });

  it("shows a moved file at its new place and a new addition as pending", () => {
    const entries = folderEditResult(current, new Set(["mp3/01.mp3", "mp3/02.mp3"]), null, layout, [
      { key: "local:12:notes.txt", path: "notes.txt", kind: "text", sizeBytes: 3 },
    ]);
    expect(entries.map((entry) => [entry.path, entry.state])).toEqual([
      ["Disc 1/01.mp3", "add_move"],
      ["mp3/02.mp3", "keep"],
      ["Extras/notes.txt", "pending"],
    ]);
  });
});

describe("an arranged Fetch", () => {
  const fetched: FolderEditResource = {
    ...other,
    id: "remote:7:RJ00000001",
    kind: "remote",
    editionCode: "RJ00000001",
    folderId: 0,
    rootPath: "",
    sourceId: 7,
    sourceName: "Example Remote",
  };
  const request = fetchComposeRequest({
    fetch: { sourceId: 7, sourceName: "Example Remote", remoteCode: "RJ00000001", editionCode: "RJ00000001" },
    resources: [fetched, other],
    files: {
      [fetched.id]: [{ path: "mp3/01.mp3", name: "01.mp3", kind: "audio", sizeBytes: 10, locationId: null }],
      "local:12": [{ path: "notes.txt", name: "notes.txt", kind: "text", sizeBytes: 3, locationId: 201 }],
    },
    selection: { [fetched.id]: new Set(["mp3/01.mp3"]), "local:12": new Set(["notes.txt"]) },
    lyrics: {},
    decisions: {},
    minFreeBytes: 0,
    layout: {
      placements: { [fetchItemKey("mp3/01.mp3")]: "Disc 1/01.mp3", "local:12:notes.txt": "Extras/notes.txt" },
      folders: [],
    },
  });

  it("renames a placed file of the fetched edition and places a follow-up file", () => {
    expect(request.paths).toEqual(["mp3/01.mp3"]);
    expect(request.decisions).toEqual([
      { itemKey: "remote:mp3/01.mp3", sourceId: 0, resolution: "rename", targetPath: "Disc 1/01.mp3" },
    ]);
    expect(request.followUp?.additions).toEqual([
      { kind: "local", folderId: 12, path: "notes.txt", targetPath: "Extras/notes.txt" },
    ]);
  });
});

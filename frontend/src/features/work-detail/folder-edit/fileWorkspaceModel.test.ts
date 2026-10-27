import { describe, expect, it } from "vitest";

import {
  compactLibraryPath,
  folderEditDuplicates,
  folderEditPendingDeletions,
  type PendingDeletion,
} from "./fileWorkspaceModel";
import { currentFileKey, type FolderEditFile, type FolderEditResource } from "./folderEditModel";

function file(locationId: number, path: string, sizeBytes = 100): FolderEditFile {
  return { path, name: path.split("/").pop() ?? path, kind: "audio", sizeBytes, locationId };
}

const files = [
  file(1, "mp3/01.mp3"),
  file(2, "mp3/02.mp3"),
  file(3, "wav/01.wav", 500),
  file(4, "wav/02.WAV", 500),
  file(5, "readme.txt", 1),
];

describe("identical files of the edited folder", () => {
  const duplicate = (locationId: number, workCode: string, path: string) => ({
    locationId,
    mediaItemId: locationId,
    workId: workCode === "RJ00000000" ? 1 : 2,
    workCode,
    path,
  });

  it("treats every copy in the folder as redundant when the same file is in another folder", () => {
    const duplicates = folderEditDuplicates(
      [
        {
          sizeBytes: 100,
          files: [
            duplicate(1, "RJ00000000", "library/RJ00000000/mp3/01.mp3"),
            duplicate(2, "RJ00000000", "library/RJ00000000/mp3/02.mp3"),
            duplicate(70, "RJ00000001", "library/RJ00000001/Translated/01.mp3"),
          ],
        },
      ],
      files,
    );
    expect(duplicates.elsewhere).toEqual(["mp3/01.mp3", "mp3/02.mp3"]);
    expect(duplicates.repeated).toEqual([]);
    expect(duplicates.marks.get("mp3/01.mp3")).toMatchObject({ elsewhere: true, counterpart: { locationId: 70 } });
    expect(compactLibraryPath(duplicates.marks.get("mp3/01.mp3")?.counterpart.path ?? "")).toBe("Translated/01.mp3");
  });

  it("keeps the first file of a set that exists only in the folder", () => {
    const duplicates = folderEditDuplicates(
      [
        {
          sizeBytes: 500,
          files: [
            duplicate(3, "RJ00000000", "library/RJ00000000/wav/01.wav"),
            duplicate(4, "RJ00000000", "library/RJ00000000/wav/02.WAV"),
          ],
        },
        // A set whose copies are all outside the folder is not this folder's concern.
        {
          sizeBytes: 9,
          files: [
            duplicate(80, "RJ00000001", "library/RJ00000001/a.txt"),
            duplicate(81, "RJ00000001", "library/RJ00000001/b.txt"),
          ],
        },
      ],
      files,
    );
    expect(duplicates.repeated).toEqual(["wav/02.WAV"]);
    expect(duplicates.elsewhere).toEqual([]);
    expect([...duplicates.marks.keys()].sort()).toEqual(["wav/01.wav", "wav/02.WAV"]);
    expect(duplicates.marks.get("wav/01.wav")).toMatchObject({ elsewhere: false, counterpart: { locationId: 4 } });
  });
});

describe("files the edit deletes", () => {
  const merged: FolderEditResource = {
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

  it("groups cleared files by their folder and adds up their size", () => {
    const pending = folderEditPendingDeletions({
      currentFiles: files,
      currentSelection: new Set(["mp3/01.mp3", "mp3/02.mp3", "readme.txt"]),
      result: [],
      merged: [],
    });
    expect(pending.groups.map((group) => [group.folder, group.items.map(itemPath)])).toEqual([
      ["wav", ["wav/01.wav", "wav/02.WAV"]],
    ]);
    expect([pending.files, pending.sizeBytes]).toEqual([2, 1000]);
  });

  it("lists a kept file an incoming file replaces, with the incoming file that keeps it", () => {
    const pending = folderEditPendingDeletions({
      currentFiles: files,
      currentSelection: new Set(files.map((entry) => entry.path)),
      result: [
        {
          key: currentFileKey("readme.txt"),
          path: "readme.txt",
          name: "readme.txt",
          kind: "text",
          sizeBytes: 1,
          state: "replaced",
          item: null,
        },
        {
          key: "local:12:readme.txt",
          path: "readme.txt",
          name: "readme.txt",
          kind: "text",
          sizeBytes: 2,
          state: "add_local",
          item: {
            itemKey: "local:12:readme.txt",
            resolution: "replace",
            targetConflict: false,
            targetConflictReason: "",
            sourceKind: "local",
            remoteSourceName: "",
            localSourcePath: "Library/RJ00000002/readme.txt",
          },
        },
      ],
      merged: [],
    });
    expect(pending.groups[0].items).toEqual([
      expect.objectContaining({
        kind: "replaced",
        path: "readme.txt",
        incoming: { itemKey: "local:12:readme.txt", targetPath: "readme.txt" },
      }),
    ]);
  });

  it("counts a merged folder as a whole, once its files are known", () => {
    const pending = folderEditPendingDeletions({
      currentFiles: files,
      currentSelection: new Set(files.map((entry) => entry.path)),
      result: [],
      merged: [{ resource: merged, files: [file(20, "a.mp3", 40), file(21, "b.mp3", 60)] }],
    });
    expect(pending.groups).toEqual([
      expect.objectContaining({ merged: true, items: [expect.objectContaining({ kind: "merged", files: 2 })] }),
    ]);
    expect([pending.files, pending.sizeBytes]).toEqual([2, 100]);
  });
});

function itemPath(item: PendingDeletion) {
  return item.kind === "merged" ? item.resource.rootPath : item.path;
}

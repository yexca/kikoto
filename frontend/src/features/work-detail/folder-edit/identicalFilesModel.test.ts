import { describe, expect, it } from "vitest";

import type { FolderEditFile, FolderEditResource } from "./folderEditModel";
import { hasCopyMark, identicalFiles, identicalSetState, withIdenticalPlan } from "./identicalFilesModel";

function file(locationId: number, path: string, sizeBytes = 100): FolderEditFile {
  return { path, name: path.split("/").pop() ?? path, kind: "audio", sizeBytes, locationId };
}

const duplicate = (locationId: number, workCode: string, path: string) => ({
  locationId,
  mediaItemId: locationId,
  workId: workCode === "RJ00000000" ? 1 : 2,
  workCode,
  path,
});

const other: FolderEditResource = {
  id: "local:12",
  kind: "local",
  editionCode: "RJ00000001",
  language: "",
  origin: false,
  folderId: 12,
  workId: 2,
  rootPath: "Library/RJ00000001",
  sourceId: 0,
  sourceName: "",
};

describe("the copy a repeated file keeps", () => {
  it("recognizes the marks file managers add to a copy", () => {
    for (const name of [
      "01 (1).mp3",
      "01 (copy).mp3",
      "01 (copy 2).mp3",
      "01 - Copy.mp3",
      "01 - コピー.mp3",
      "01 のコピー.mp3",
      "01 - 副本.mp3",
      "01 - 複製.mp3",
      "01 - 복사본.mp3",
      "01 copy.mp3",
      "Copy of 01.mp3",
    ]) {
      expect(hasCopyMark(name), name).toBe(true);
    }
    for (const name of ["01.mp3", "copyright.txt", "Disc 1.mp3", "01 Copycat.mp3"]) {
      expect(hasCopyMark(name), name).toBe(false);
    }
  });

  it("suggests the unmarked copy, then the one in the fewest folders, then the first by path", () => {
    const files = [
      file(1, "01 (1).mp3"),
      file(2, "backup/01.mp3"),
      file(3, "a/b/02.mp3"),
      file(4, "a/02.mp3"),
      file(5, "z.mp3"),
      file(6, "y.mp3"),
    ];
    const found = identicalFiles(
      [
        {
          sizeBytes: 100,
          files: [
            duplicate(1, "RJ00000000", "Library/RJ00000000/01 (1).mp3"),
            duplicate(2, "RJ00000000", "Library/RJ00000000/backup/01.mp3"),
          ],
        },
        {
          sizeBytes: 100,
          files: [
            duplicate(3, "RJ00000000", "Library/RJ00000000/a/b/02.mp3"),
            duplicate(4, "RJ00000000", "Library/RJ00000000/a/02.mp3"),
          ],
        },
        {
          sizeBytes: 100,
          files: [
            duplicate(5, "RJ00000000", "Library/RJ00000000/z.mp3"),
            duplicate(6, "RJ00000000", "Library/RJ00000000/y.mp3"),
          ],
        },
      ],
      files,
      [],
    );
    expect(found.sets.map((set) => set.suggestedKeep).sort()).toEqual(["a/02.mp3", "backup/01.mp3", "y.mp3"]);
    expect(found.sets.every((set) => set.kind === "repeated")).toBe(true);
  });
});

describe("identical files with a copy in another folder", () => {
  const files = [file(1, "mp3/01.mp3"), file(2, "mp3/01 (1).mp3"), file(5, "readme.txt", 1)];
  const found = identicalFiles(
    [
      {
        sizeBytes: 100,
        files: [
          duplicate(1, "RJ00000000", "Library/RJ00000000/mp3/01.mp3"),
          duplicate(2, "RJ00000000", "Library/RJ00000000/mp3/01 (1).mp3"),
          duplicate(70, "RJ00000001", "Library/RJ00000001/Translated/01.mp3"),
        ],
      },
      // A set with no copy in the edited folder is not its concern.
      {
        sizeBytes: 9,
        files: [
          duplicate(80, "RJ00000001", "Library/RJ00000001/a.txt"),
          duplicate(81, "RJ00000001", "Library/RJ00000001/b.txt"),
        ],
      },
    ],
    files,
    [other],
  );

  it("deletes every copy here and points to the other folder's copy as a reference", () => {
    expect(found.sets).toHaveLength(1);
    const [set] = found.sets;
    expect(set.kind).toBe("elsewhere");
    expect(set.suggestedKeep).toBeNull();
    expect(set.outside).toEqual([
      expect.objectContaining({
        place: "local",
        resourceId: "local:12",
        path: "Translated/01.mp3",
        workCode: "RJ00000001",
      }),
    ]);
    const state = identicalSetState(set, new Set(files.map((each) => each.path)));
    expect(state).toMatchObject({ status: "none", planned: ["mp3/01.mp3", "mp3/01 (1).mp3"], lost: false });
  });

  it("reads the edit's own deletions back as the set's state", () => {
    const [set] = found.sets;
    const all = new Set(files.map((each) => each.path));
    const applied = withIdenticalPlan(all, set, null);
    expect([...applied]).toEqual(["readme.txt"]);
    expect(identicalSetState(set, applied).status).toBe("applied");
    expect(identicalSetState(set, new Set(["mp3/01.mp3", "readme.txt"])).status).toBe("partial");
  });
});

describe("a set repeated only in the edited folder", () => {
  const files = [file(1, "01.mp3"), file(2, "01 (1).mp3"), file(3, "old/01.mp3")];
  const [set] = identicalFiles(
    [
      {
        sizeBytes: 100,
        files: [
          duplicate(2, "RJ00000000", "Library/RJ00000000/01 (1).mp3"),
          duplicate(1, "RJ00000000", "Library/RJ00000000/01.mp3"),
          duplicate(3, "RJ00000000", "Library/RJ00000000/old/01.mp3"),
        ],
      },
    ],
    files,
    [],
  ).sets;
  const all = new Set(files.map((each) => each.path));

  it("keeps the chosen copy, and the copy the edit leaves alone once it deletes the others", () => {
    expect(identicalSetState(set, all).keep).toBe("01.mp3");
    expect(identicalSetState(set, all, "old/01.mp3").planned).toEqual(["01.mp3", "01 (1).mp3"]);
    const keptOld = withIdenticalPlan(all, set, "old/01.mp3");
    expect(identicalSetState(set, keptOld)).toMatchObject({ keep: "old/01.mp3", status: "applied" });
  });

  it("says when every copy is deleted and the content is lost", () => {
    expect(identicalSetState(set, new Set()).lost).toBe(true);
  });
});

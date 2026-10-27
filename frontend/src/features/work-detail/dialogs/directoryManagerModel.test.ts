import { describe, expect, it } from "vitest";

import type { TreeNode, TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import {
  directoryManagerFormatGroups,
  directoryManagerLocationGroups,
  directoryManagerSelectionState,
  fileExtension,
  withTargetKeys,
} from "./directoryManagerModel";
import { directoryManageTargets } from "./mediaDeleteTargets";

function file(id: number, sourcePath: string, overrides: Partial<TreeTrack> = {}): TreeTrack {
  const title = sourcePath.split("/").pop() ?? sourcePath;
  return {
    mediaItemId: id,
    locationId: id,
    title,
    baseName: title.replace(/\.[^.]+$/, ""),
    sourcePath,
    kind: "audio",
    folderPath: "",
    locationType: "local",
    streamUrl: "",
    downloadUrl: "",
    assetUrl: "",
    sizeBytes: 100,
    durationSeconds: 60,
    hasAudio: null,
    availability: "available",
    cacheLocationId: null,
    cachePath: "",
    cacheAvailable: false,
    cacheStreamUrl: "",
    localLocationId: id,
    localPath: `RJ00000000/${sourcePath}`,
    localAvailable: true,
    progress: null,
    locations: [],
    ...overrides,
  };
}

function folder(name: string, files: TreeTrack[]): TreeNode {
  return { name, path: name, children: new Map(), files };
}

const cached = { cacheLocationId: 99, cachePath: "cache/RJ00000000/mp3/01.mp3", cacheAvailable: true };
const root: TreeNode = {
  name: "",
  path: "",
  files: [file(5, "readme.txt", { kind: "text", sizeBytes: 1 })],
  children: new Map([
    ["mp3", folder("mp3", [file(1, "mp3/01.mp3", cached), file(2, "mp3/02.mp3")])],
    ["wav", folder("wav", [file(3, "wav/01.wav", { sizeBytes: 500 }), file(4, "wav/02.WAV", { sizeBytes: 500 })])],
  ]),
};
const options = { allowCacheDelete: true, allowLocalDelete: true };

describe("directory manager selection model", () => {
  it("reads a lower-case extension from the file name only", () => {
    expect(fileExtension("Disc.1/Track 01.FLAC")).toBe("flac");
    expect(fileExtension("folder.v2/README")).toBe("");
    expect(fileExtension(".hidden")).toBe("");
  });

  it("groups formats by file with every deletable copy, largest first", () => {
    const groups = directoryManagerFormatGroups(root, options);
    expect(groups.map((group) => [group.key, group.files, group.sizeBytes])).toEqual([
      ["wav", 2, 1000],
      ["mp3", 2, 200],
      ["txt", 1, 1],
    ]);
    expect(groups.find((group) => group.key === "mp3")?.targetKeys).toEqual(["cache:99", "local:1", "local:2"]);
  });

  it("only offers formats and locations the current source may delete", () => {
    const cacheOnly = { allowCacheDelete: true, allowLocalDelete: false };
    expect(directoryManagerFormatGroups(root, cacheOnly).map((group) => group.key)).toEqual(["mp3"]);
    const locations = directoryManagerLocationGroups(directoryManageTargets(root, options));
    expect(locations.map((group) => [group.key, group.files])).toEqual([
      ["local", 5],
      ["cache", 1],
    ]);
  });

  it("reports partial selection and adds or removes a whole group", () => {
    const keys = ["local:1", "cache:99"];
    expect(directoryManagerSelectionState(keys, new Set(["local:1"]))).toEqual({
      selected: 1,
      total: 2,
      checked: false,
      indeterminate: true,
    });
    const selected = withTargetKeys(new Set(["local:5"]), keys, true);
    expect(directoryManagerSelectionState(keys, selected).checked).toBe(true);
    expect([...withTargetKeys(selected, keys, false)]).toEqual(["local:5"]);
    expect(directoryManagerSelectionState([], new Set()).checked).toBe(false);
  });
});

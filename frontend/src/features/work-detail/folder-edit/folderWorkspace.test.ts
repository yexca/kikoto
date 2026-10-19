import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import { emptyFolderEditLayout } from "./folderEditLayout";
import { folderEditResourceItemKey, type FolderEditResource } from "./folderEditModel";
import { folderWorkspaceArrange, sharedLoad } from "./folderWorkspace";

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

describe("folder workspace loads", () => {
  it("gives a second request for a place in flight the same load", async () => {
    const inFlight = new Map<string, Promise<string[] | null>>();
    let finish: (files: string[]) => void = () => undefined;
    const load = vi.fn(() => new Promise<string[] | null>((resolve) => (finish = resolve)));

    const first = sharedLoad(inFlight, "local:12", load);
    const second = sharedLoad(inFlight, "local:12", load);
    finish(["mp3/01.mp3"]);

    expect(load).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toEqual(["mp3/01.mp3"]);
    await expect(first).resolves.toEqual(["mp3/01.mp3"]);
    expect(inFlight.size).toBe(0);
  });
});

describe("folder workspace arrange", () => {
  it("refuses a dropped tree that holds Kikoto's lyrics folder", () => {
    const setLayout = vi.fn();
    const include = vi.fn();
    const arrange = folderWorkspaceArrange({
      layout: emptyFolderEditLayout,
      setLayout,
      entries: [],
      include,
      forget: () => undefined,
      keyFor: folderEditResourceItemKey,
    });

    arrange.placeFromResource(other, ["mp3/01.mp3", "lyrics_kikoto/ja/mp3/01.vtt"], "", "Disc 1");
    expect(include).not.toHaveBeenCalled();
    expect(setLayout).not.toHaveBeenCalled();

    arrange.placeFromResource(other, ["mp3/01.mp3"], "", "Disc 1");
    expect(include).toHaveBeenCalledWith(other, ["mp3/01.mp3"]);
    expect(setLayout).toHaveBeenCalledWith({ placements: { "local:12:mp3/01.mp3": "Disc 1/mp3/01.mp3" }, folders: [] });
  });
});

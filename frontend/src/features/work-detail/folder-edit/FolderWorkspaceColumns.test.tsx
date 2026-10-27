import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import "@/i18n";

import type { FolderEditResource } from "./folderEditModel";
import type { FolderEditFilesState, FolderWorkspace } from "./folderWorkspace";
import { CopyMergeSwitch } from "./FolderWorkspaceColumns";

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

/** Whether Merge renders disabled in the Copy / Merge switch. */
function mergeSwitchDisabled(files: FolderEditFilesState) {
  const workspace = {
    activeResource: other,
    files: { [other.id]: files },
    selection: {},
    lyrics: {},
    applying: false,
    merge: { folderIds: new Set<number>(), setMerged: () => undefined },
    setSelected: () => undefined,
    setLyricsRole: () => undefined,
  } as unknown as FolderWorkspace;
  const markup = renderToStaticMarkup(<CopyMergeSwitch workspace={workspace} resource={other} />);
  const button = [...markup.matchAll(/<button[^>]*role="radio"[^>]*>/g)][1]?.[0] ?? "";
  return / disabled=""/.test(button);
}

describe("Merge for another local folder", () => {
  it("turns on only once the folder's files have loaded", () => {
    expect(mergeSwitchDisabled({ status: "loading", files: [] })).toBe(true);
    expect(
      mergeSwitchDisabled({
        status: "ready",
        files: [{ path: "mp3/01.mp3", name: "01.mp3", kind: "audio", sizeBytes: 10, locationId: 201 }],
      }),
    ).toBe(false);
  });
});

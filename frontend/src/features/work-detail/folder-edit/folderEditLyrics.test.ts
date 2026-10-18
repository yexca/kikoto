import { describe, expect, it } from "vitest";

import type { LyricsManagerAudio } from "@/features/work-detail/lyrics/lyricsManagerModel";
import type { WorkFolderEditItem } from "@/lib/api";

import { folderEditAssignments } from "./folderEditLyrics";

function audio(mediaItemId: number, path: string, assignedLyrics: Record<string, number> = {}): LyricsManagerAudio {
  return {
    mediaItemId,
    title: path.split("/").pop() ?? path,
    path,
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    durationSeconds: null,
    assignedLyrics,
    autoLyricsMediaItemId: null,
  };
}

function lyrics(path: string) {
  return { kind: "remote" as const, sourceId: 7, remoteCode: "RJ00000002", path, language: "zh-cn" };
}

describe("folder edit lyrics assignments", () => {
  it("names audio in the folder by its media item and audio being added by its path", () => {
    expect(
      folderEditAssignments({
        audio: [audio(5, "mp3/01 Opening.mp3")],
        addedAudio: ["mp3/02 Ending.mp3"],
        additions: [lyrics("sub/01 Opening.mp3.vtt"), lyrics("sub/02 Ending.mp3.vtt")],
        items: [],
      }),
    ).toEqual([
      { audioMediaItemId: 5, itemKey: "remote:7:RJ00000002:sub/01 Opening.mp3.vtt" },
      { audioPath: "mp3/02 Ending.mp3", itemKey: "remote:7:RJ00000002:sub/02 Ending.mp3.vtt" },
    ]);
  });

  it("keeps the lyrics a track has in the language and skips files the plan leaves out", () => {
    const conflict = { itemKey: "remote:7:RJ00000002:sub/02 Ending.mp3.vtt", action: "conflict" } as WorkFolderEditItem;
    expect(
      folderEditAssignments({
        audio: [audio(5, "mp3/01 Opening.mp3", { "zh-cn": 40 })],
        addedAudio: ["mp3/02 Ending.mp3"],
        additions: [
          lyrics("sub/01 Opening.mp3.vtt"),
          lyrics("sub/02 Ending.mp3.vtt"),
          { ...lyrics("notes.txt"), language: undefined },
        ],
        items: [conflict],
      }),
    ).toEqual([]);
  });
});

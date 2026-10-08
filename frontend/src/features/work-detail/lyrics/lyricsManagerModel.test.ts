import { describe, expect, it } from "vitest";

import type { MediaItem } from "@/lib/api";
import { findLocalLyricsChoices } from "@/player/lyricsMatching";
import { syntheticWorkCode } from "@/test-support/workCode";

import {
  alignLyricsByOrder,
  effectiveLyricsMediaItemId,
  initialLyricsAssignmentDraft,
  lyricsAssignmentChanges,
  lyricsFolders,
  lyricsManagerEntries,
  lyricsTimingCheck,
} from "./lyricsManagerModel";

const workRoot = `Library/${syntheticWorkCode("RJ", 0)}`;

function localItem(
  id: number,
  kind: string,
  relativePath: string,
  options: { durationSeconds?: number; assignedLyricsMediaItemId?: number } = {},
): MediaItem {
  const path = `${workRoot}/${relativePath}`;
  return {
    id,
    parentId: null,
    kind,
    title: relativePath,
    discNo: null,
    trackNo: null,
    durationSeconds: options.durationSeconds ?? null,
    sizeBytes: null,
    fingerprint: path,
    progress: null,
    assignedLyricsMediaItemId: options.assignedLyricsMediaItemId ?? null,
    locations: [
      {
        id: id + 1000,
        fileSourceId: 1,
        fileSourceCode: "local",
        fileSourceName: "Local",
        locationType: "local",
        path,
        streamUrl: "",
        downloadUrl: "",
        remoteHash: "",
        sizeBytes: null,
        durationSeconds: options.durationSeconds ?? null,
        availability: "available",
        lastCheckedAt: null,
      },
    ],
  };
}

describe("lyricsManagerEntries", () => {
  it("lists local audio and lyrics below the work folder with their automatic match", () => {
    const entries = lyricsManagerEntries([
      localItem(2, "audio", "mp3/02 Second.mp3"),
      localItem(1, "audio", "mp3/01 First.mp3", { assignedLyricsMediaItemId: 12 }),
      localItem(11, "text", "mp3/01 First.mp3.vtt"),
      localItem(12, "file", "Translated/Track1.vtt"),
      localItem(20, "image", "cover.jpg"),
    ]);
    expect(
      entries.audio.map((entry) => [entry.path, entry.assignedLyricsMediaItemId, entry.autoLyricsMediaItemId]),
    ).toEqual([
      ["mp3/01 First.mp3", 12, 11],
      ["mp3/02 Second.mp3", null, null],
    ]);
    expect(entries.lyrics.map((file) => [file.path, file.folder])).toEqual([
      ["mp3/01 First.mp3.vtt", "mp3"],
      ["Translated/Track1.vtt", "Translated"],
    ]);
    expect(lyricsFolders(entries.lyrics).map((folder) => folder.folder)).toEqual(["mp3", "Translated"]);
  });
});

describe("lyrics assignment draft", () => {
  it("sends only changed rows and treats automatic as clearing the assignment", () => {
    const { audio } = lyricsManagerEntries([
      localItem(1, "audio", "01.mp3", { assignedLyricsMediaItemId: 11 }),
      localItem(2, "audio", "02.mp3"),
      localItem(3, "audio", "03.mp3"),
      localItem(11, "text", "lyrics/a.vtt"),
      localItem(12, "text", "lyrics/b.vtt"),
    ]);
    const draft = initialLyricsAssignmentDraft(audio);
    expect(lyricsAssignmentChanges(audio, draft)).toEqual([]);
    draft.set(1, null);
    draft.set(2, 12);
    expect(lyricsAssignmentChanges(audio, draft)).toEqual([
      { audioMediaItemId: 1, lyricsMediaItemId: null },
      { audioMediaItemId: 2, lyricsMediaItemId: 12 },
    ]);
    expect(effectiveLyricsMediaItemId(audio[1], draft)).toBe(12);
  });
});

describe("alignLyricsByOrder", () => {
  it("pairs translated lyrics by track number when names differ", () => {
    const { audio, lyrics } = lyricsManagerEntries([
      localItem(1, "audio", "mp3/Track1.Original name.mp3"),
      localItem(2, "audio", "mp3/Track2.Another name.mp3"),
      localItem(3, "audio", "wav/Track1.Original name.wav"),
      localItem(11, "text", "Translated/Track2.Translated name.mp3.vtt"),
      localItem(12, "text", "Translated/Track1.Translated name.mp3.vtt"),
    ]);
    expect(Object.fromEntries(alignLyricsByOrder(audio, lyrics, "Translated"))).toEqual({ 1: 12, 2: 11, 3: 12 });
  });

  it("falls back to position only when the counts are equal", () => {
    const { audio, lyrics } = lyricsManagerEntries([
      localItem(1, "audio", "main/Opening.mp3"),
      localItem(2, "audio", "main/Ending.mp3"),
      localItem(3, "audio", "bonus/Extra.mp3"),
      localItem(11, "text", "subs/a.lrc"),
      localItem(12, "text", "subs/b.lrc"),
    ]);
    // Natural order: Ending, Opening against a, b. The single-file bonus folder is left alone.
    expect(Object.fromEntries(alignLyricsByOrder(audio, lyrics, "subs"))).toEqual({ 2: 11, 1: 12 });
  });
});

describe("lyricsTimingCheck", () => {
  it("flags timed lyrics that continue well past the audio", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:05:00.000 --> 00:05:02.000\nLate line\n";
    expect(lyricsTimingCheck(vtt, 120)).toMatchObject({
      timed: true,
      lineCount: 2,
      lastLineSeconds: 300,
      exceedsAudio: true,
    });
    expect(lyricsTimingCheck(vtt, 300).exceedsAudio).toBe(false);
    expect(lyricsTimingCheck(vtt, null).exceedsAudio).toBe(false);
    expect(lyricsTimingCheck("plain text", 120)).toMatchObject({ timed: false, exceedsAudio: false });
  });
});

describe("findLocalLyricsChoices", () => {
  it("leads with the library assignment even when its name does not match", () => {
    const items = [
      localItem(1, "audio", "mp3/01 First.mp3"),
      localItem(11, "text", "mp3/01 First.mp3.vtt"),
      localItem(12, "text", "Translated/Track1.vtt"),
    ];
    expect(findLocalLyricsChoices(`${workRoot}/mp3/01 First.mp3`, items).map((choice) => choice.mediaItemId)).toEqual([
      11,
    ]);
    expect(
      findLocalLyricsChoices(`${workRoot}/mp3/01 First.mp3`, items, 12).map((choice) => [
        choice.mediaItemId,
        choice.reason,
      ]),
    ).toEqual([
      [12, "assigned"],
      [11, "exact_sidecar"],
    ]);
    // An assignment to a file that is no longer available falls back to name matching.
    expect(
      findLocalLyricsChoices(`${workRoot}/mp3/01 First.mp3`, items, 99).map((choice) => choice.mediaItemId),
    ).toEqual([11]);
  });
});

import { describe, expect, it } from "vitest";

import type { MediaFileLocation, MediaItem } from "@/lib/api";
import type { PlayerTrack } from "./playerTypes";
import { mediaItemDisplayTitle, withQueueDisplayTitles } from "./queueDisplayNames";

function location(id: number, path: string, displayPath?: string): MediaFileLocation {
  return {
    id,
    fileSourceId: 1,
    fileSourceCode: "local",
    fileSourceName: "Local",
    locationType: id >= 200 ? "cache" : "local",
    path,
    ...(displayPath ? { displayPath } : {}),
    streamUrl: `/api/media/${id}/stream`,
    downloadUrl: "",
    remoteHash: "",
    sizeBytes: 1000,
    durationSeconds: 60,
    availability: "available",
    lastCheckedAt: null,
  };
}

function mediaItem(id: number, locations: MediaFileLocation[]): MediaItem {
  return {
    id,
    parentId: null,
    kind: "audio",
    title: "track",
    discNo: null,
    trackNo: null,
    durationSeconds: 60,
    sizeBytes: 1000,
    fingerprint: "",
    progress: null,
    locations,
  };
}

function queued(queueItemId: string, workId: number, mediaItemId: number, locationId: number, displayTitle?: string) {
  return {
    queueItemId,
    mediaItemId,
    locationId,
    title: "01 track.mp3",
    ...(displayTitle ? { displayTitle } : {}),
    kind: "audio",
    folderPath: "",
    locationType: "local",
    streamUrl: `/api/media/${locationId}/stream`,
    sizeBytes: null,
    availability: "available",
    workId,
    workCode: "RJ00000000",
    workTitle: "Work",
    coverUrl: "",
    circle: "",
    progress: null,
    progressRecordable: true,
    lyricsLocationId: null,
    lyricsTitle: "",
  } satisfies PlayerTrack;
}

describe("queue display names", () => {
  it("reads the name of the playing location, else of any named location", () => {
    const item = mediaItem(10, [
      location(100, "library/RJ00000000/01 track.mp3", "library/RJ00000000/01 开场.mp3"),
      location(200, "cache/RJ00000000/01 track.mp3"),
    ]);
    expect(mediaItemDisplayTitle(item, 100)).toBe("01 开场.mp3");
    expect(mediaItemDisplayTitle(item, 200)).toBe("01 开场.mp3");
    // Only a renamed folder leaves the file its real name.
    const folderOnly = mediaItem(11, [
      location(101, "library/RJ00000000/mp3/01 track.mp3", "library/RJ00000000/音频/01 track.mp3"),
    ]);
    expect(mediaItemDisplayTitle(folderOnly, 101)).toBeUndefined();
  });

  it("renames queued tracks without touching anything else", () => {
    const playing = queued("q1", 1, 10, 100, "01 Opening.mp3");
    const other = queued("q2", 2, 20, 300, "Other.mp3");
    const media = new Map([[1, [mediaItem(10, [location(100, "a/01 track.mp3", "a/01 开场.mp3")])]]]);
    const [renamed, untouched] = withQueueDisplayTitles([playing, other], media);
    expect(renamed).toEqual({ ...playing, displayTitle: "01 开场.mp3" });
    // A work that was not loaded keeps its names.
    expect(untouched).toBe(other);
  });

  it("drops a name the listener's languages no longer give, and keeps the queue when nothing changes", () => {
    const track = queued("q1", 1, 10, 100, "01 Opening.mp3");
    const realNames = new Map([[1, [mediaItem(10, [location(100, "a/01 track.mp3")])]]]);
    expect(withQueueDisplayTitles([track], realNames)[0].displayTitle).toBeUndefined();

    const unchanged = [queued("q1", 1, 10, 100)];
    expect(withQueueDisplayTitles(unchanged, realNames)).toBe(unchanged);
  });
});

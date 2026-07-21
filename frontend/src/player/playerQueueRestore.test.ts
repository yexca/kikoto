import { describe, expect, it } from "vitest";

import type { MediaItem } from "../lib/api";
import type { PlayerTrack } from "./PlayerProvider";
import { revalidatePersistedQueue } from "./playerQueueRestore";

const persistedTrack = {
  queueItemId: "queue-1",
  mediaItemId: 10,
  locationId: 100,
  title: "Track",
  folderPath: "",
  locationType: "local",
  streamUrl: "/api/media/100/stream",
  sizeBytes: null,
  availability: "available",
  workId: 1,
  workCode: "RJ09999995",
  workTitle: "Work",
  coverUrl: "",
  circle: "",
  progress: null,
  progressRecordable: true,
  lyricsLocationId: null,
  lyricsTitle: "",
} satisfies PlayerTrack;

describe("revalidatePersistedQueue", () => {
  it("replaces a stale location with the current preferred location", async () => {
    const mediaItems = [
      {
        id: 10,
        parentId: null,
        kind: "audio",
        title: "Track",
        discNo: null,
        trackNo: null,
        durationSeconds: 60,
        sizeBytes: 1000,
        fingerprint: "",
        progress: null,
        locations: [
          {
            id: 101,
            fileSourceId: 1,
            fileSourceCode: "local",
            fileSourceName: "Local",
            locationType: "local",
            path: "track.mp3",
            streamUrl: "/api/media/101/stream",
            downloadUrl: "",
            remoteHash: "",
            sizeBytes: 1000,
            durationSeconds: 60,
            availability: "available",
            lastCheckedAt: null,
          },
        ],
      },
    ] satisfies MediaItem[];

    const result = await revalidatePersistedQueue([persistedTrack], async () => mediaItems);
    expect(result).toHaveLength(1);
    expect(result[0].locationId).toBe(101);
    expect(result[0].streamUrl).toBe("/api/media/101/stream");
  });

  it("removes a queue item whose media no longer exists", async () => {
    await expect(revalidatePersistedQueue([persistedTrack], async () => [])).resolves.toEqual([]);
  });
});

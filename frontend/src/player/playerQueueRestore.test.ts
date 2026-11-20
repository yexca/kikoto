import { describe, expect, it } from "vitest";

import type { MediaItem } from "../lib/api";
import type { PlayerTrack } from "./playerTypes";
import { keepPlayingTrackLocation, revalidatePersistedQueue } from "./playerQueueRestore";

const persistedTrack = {
  queueItemId: "queue-1",
  mediaItemId: 10,
  locationId: 100,
  title: "Track",
  kind: "audio",
  folderPath: "",
  locationType: "local",
  streamUrl: "/api/media/100/stream",
  sizeBytes: null,
  availability: "available",
  workId: 1,
  workCode: "RJ00000000",
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
        hasAudio: true,
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

    const result = await revalidatePersistedQueue(
      // A name the file no longer has in the listener's languages is dropped.
      [{ ...persistedTrack, displayTitle: "旧名.mp3" }],
      async () => mediaItems,
      async () => ({
        primaryCode: "RJ00000000",
        title: "Refreshed work",
        coverUrl: "/api/assets/covers/RJ/000/RJ00000000.jpg",
        circle: "Refreshed circle",
        voiceActors: ["Refreshed voice"],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].locationId).toBe(101);
    expect(result[0].streamUrl).toBe("/api/media/101/stream");
    expect(result[0]).toMatchObject({
      workTitle: "Refreshed work",
      coverUrl: "/api/assets/covers/RJ/000/RJ00000000.jpg",
      circle: "Refreshed circle",
      voiceActors: ["Refreshed voice"],
      displayTitle: undefined,
    });
  });

  it("proxies a tracked remote media location after queue restoration", async () => {
    const mediaItems = [
      {
        id: 10,
        parentId: null,
        kind: "video",
        title: "clip.avi",
        discNo: null,
        trackNo: null,
        durationSeconds: 60,
        hasAudio: true,
        sizeBytes: 1000,
        fingerprint: "remote-video",
        progress: null,
        locations: [
          {
            id: 101,
            fileSourceId: 7,
            fileSourceCode: "remote",
            fileSourceName: "Remote",
            locationType: "remote_stream",
            path: "clip.avi",
            streamUrl: "https://media.invalid/clip.avi",
            downloadUrl: "",
            remoteHash: "",
            sizeBytes: 1000,
            durationSeconds: 60,
            availability: "remote",
            lastCheckedAt: null,
          },
        ],
      },
    ] satisfies MediaItem[];

    const result = await revalidatePersistedQueue(
      [
        {
          ...persistedTrack,
          kind: "video",
          locationType: "remote_stream",
          streamUrl: "https://media.invalid/clip.avi",
        },
      ],
      async () => mediaItems,
    );
    expect(result[0].streamUrl).toBe("/api/media/101/stream");
  });

  it("restores a tracked remote location that only has a download URL", async () => {
    const mediaItems = [
      {
        id: 10,
        parentId: null,
        kind: "video",
        title: "clip.avi",
        discNo: null,
        trackNo: null,
        durationSeconds: 60,
        hasAudio: true,
        sizeBytes: 1000,
        fingerprint: "remote-download-only",
        progress: null,
        locations: [
          {
            id: 102,
            fileSourceId: 7,
            fileSourceCode: "remote",
            fileSourceName: "Remote",
            locationType: "remote_stream",
            path: "clip.avi",
            streamUrl: "",
            downloadUrl: "https://media.invalid/clip.avi",
            remoteHash: "",
            sizeBytes: 1000,
            durationSeconds: 60,
            availability: "available",
            lastCheckedAt: null,
          },
        ],
      },
    ] satisfies MediaItem[];

    const result = await revalidatePersistedQueue(
      [{ ...persistedTrack, kind: "video", locationType: "remote_stream" }],
      async () => mediaItems,
    );

    expect(result[0].streamUrl).toBe("/api/media/102/stream");
  });

  it("restores the local copy unless the listener picked another location in the player", async () => {
    const location = (id: number, locationType: string, fileSourceId: number) => ({
      id,
      fileSourceId,
      fileSourceCode: locationType,
      fileSourceName: locationType,
      locationType,
      path: "track.mp3",
      streamUrl: `/api/media/${id}/stream`,
      downloadUrl: "",
      remoteHash: "",
      sizeBytes: 1000,
      durationSeconds: 60,
      availability: locationType === "remote_stream" ? "remote" : "available",
      lastCheckedAt: null,
    });
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
        locations: [location(100, "local", 1), location(200, "cache", 2), location(300, "remote_stream", 3)],
      },
    ] satisfies MediaItem[];
    const savedOnCache = {
      ...persistedTrack,
      locationId: 200,
      locationType: "cache",
      streamUrl: "/api/media/200/stream",
    };

    const [automatic] = await revalidatePersistedQueue([savedOnCache], async () => mediaItems);
    expect(automatic.locationId).toBe(100);

    const [chosen] = await revalidatePersistedQueue(
      [{ ...savedOnCache, locationChosen: true }],
      async () => mediaItems,
    );
    expect(chosen).toMatchObject({ locationId: 200, locationChosen: true });

    // An item already playing from the cache stays there, rather than reload
    // from the local copy and start again from 0:00.
    const [playing] = keepPlayingTrackLocation([automatic], savedOnCache);
    expect(playing).toMatchObject({ locationId: 200, streamUrl: "/api/media/200/stream" });
    expect(playing.playbackKey).not.toBe(automatic.playbackKey);
    expect(keepPlayingTrackLocation([automatic], { ...savedOnCache, locationId: 999 })).toEqual([automatic]);
  });

  it("removes a queue item whose media no longer exists", async () => {
    await expect(revalidatePersistedQueue([persistedTrack], async () => [])).resolves.toEqual([]);
  });

  it("replaces obsolete persisted progress with the current work cursor", async () => {
    const obsoletePersistedProgress = {
      positionSeconds: 42,
      durationSeconds: 60,
      completed: false,
      lastPlayedAt: "2026-07-21T01:00:30.000Z",
    };
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
        progress: { ...obsoletePersistedProgress, positionSeconds: 20, lastPlayedAt: "2026-07-21 01:00:00" },
        locations: [
          {
            id: 100,
            fileSourceId: 1,
            fileSourceCode: "local",
            fileSourceName: "Local",
            locationType: "local",
            path: "track.mp3",
            streamUrl: "/api/media/100/stream",
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

    const result = await revalidatePersistedQueue(
      [{ ...persistedTrack, progress: obsoletePersistedProgress }],
      async () => mediaItems,
    );
    expect(result[0].progress).toEqual(mediaItems[0].progress);
  });
});

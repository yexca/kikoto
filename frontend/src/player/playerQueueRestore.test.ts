import { describe, expect, it, vi } from "vitest";

import type { PlaybackQueueResolution, PlaybackQueueResolveItem, PlaybackQueueTrack } from "@/lib/api";
import type { PlayerTrack } from "./playerTypes";
import {
  keepPlayingTrackLocation,
  resolveQueueTracks,
  revalidatePersistedQueue,
  type ResolvePlaybackQueue,
} from "./playerQueueRestore";

const persistedTrack = {
  queueItemId: "queue-1",
  mediaItemId: 10,
  locationId: 200,
  title: "Track",
  kind: "audio",
  folderPath: "",
  locationType: "cache",
  streamUrl: "/api/media/200/stream",
  sizeBytes: null,
  availability: "available",
  workId: 1,
  workCode: "RJ00000000",
  workTitle: "Saved title",
  coverUrl: "",
  circle: "",
  progress: null,
  progressRecordable: true,
  lyricsLocationId: null,
  lyricsTitle: "",
} satisfies PlayerTrack;

const location = (locationId: number, locationType: string) => ({
  locationId,
  locationType,
  streamUrl: `/api/media/${locationId}/stream`,
  sourceId: locationId,
  sourceName: locationType,
  availability: locationType === "remote_stream" ? "remote" : "available",
});

function serverTrack(overrides: Partial<PlaybackQueueTrack> = {}): PlaybackQueueTrack {
  return {
    mediaItemId: 10,
    workId: 1,
    locationId: 100,
    title: "Track",
    kind: "audio",
    folderPath: "",
    locationType: "local",
    streamUrl: "/api/media/100/stream",
    availability: "available",
    sizeBytes: 1000,
    durationSeconds: 60,
    progress: { positionSeconds: 20, durationSeconds: 60, completed: false, lastPlayedAt: "2026-01-01 00:00:00" },
    locations: [location(100, "local"), location(200, "cache"), location(300, "remote_stream")],
    lyricsChoices: [
      { mediaItemId: 11, locationId: 110, title: "Track.lrc", path: "RJ00000000/Track.lrc", reason: "same_stem" },
    ],
    preferredLyricsMediaItemId: null,
    lyricsOffsetMs: 250,
    lyricsPreferencePersistable: true,
    ...overrides,
  };
}

function resolver(answer: (items: PlaybackQueueResolveItem[]) => PlaybackQueueResolution) {
  return vi.fn<ResolvePlaybackQueue>(async (items) => answer(items));
}

const exampleWork = {
  id: 1,
  primaryCode: "RJ00000000",
  title: "Example Work",
  coverUrl: "/api/assets/covers/example.jpg",
  circle: "Example Circle",
  voiceActors: ["Example Voice"],
};

describe("resolveQueueTracks", () => {
  it("names at most 100 works in one request, so a long queue of many works resolves in parts", async () => {
    const tracks = Array.from({ length: 150 }, (_, index) => ({
      ...persistedTrack,
      queueItemId: `queue-${index}`,
      mediaItemId: 1000 + index,
      workId: 1 + index,
    }));
    const resolve = resolver((items) => ({
      items: items.map((item) => ({ mediaItemId: item.mediaItemId, workId: item.workId, status: "missing" as const })),
      works: [],
    }));
    const { resolved } = await resolveQueueTracks(tracks, resolve);
    expect(resolve.mock.calls.map(([items]) => new Set(items.map((item) => item.workId)).size)).toEqual([100, 50]);
    expect(resolved.size).toBe(150);
  });
});

describe("revalidatePersistedQueue", () => {
  it("resolves the whole queue in one request and plays each item where the server chooses", async () => {
    const resolve = resolver((items) => ({
      items: items.map((item) => ({ ...item, status: "playable", track: serverTrack() })),
      works: [exampleWork],
    }));
    const queue = Array.from({ length: 40 }, (_, index) => ({ ...persistedTrack, queueItemId: `queue-${index}` }));

    const restored = await revalidatePersistedQueue(queue, resolve);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0][0]).toEqual({ mediaItemId: 10, workId: 1, locationId: 200 });
    expect(restored).toHaveLength(40);
    expect(restored[0]).toMatchObject({
      queueItemId: "queue-0",
      locationId: 100,
      locationType: "local",
      streamUrl: "/api/media/100/stream",
      workTitle: "Example Work",
      circle: "Example Circle",
      voiceActors: ["Example Voice"],
      progress: { positionSeconds: 20 },
      lyricsLocationId: 110,
      lyricsTitle: "Track.lrc",
      lyricsOffsetMs: 250,
    });
    expect(restored[0].locations?.map((candidate) => candidate.locationId)).toEqual([100, 200, 300]);
  });

  it("keeps a location the listener picked and tells the server so", async () => {
    const resolve = resolver((items) => ({
      items: items.map((item) => ({
        ...item,
        status: "playable",
        track: serverTrack({ locationId: 200, locationType: "cache", streamUrl: "/api/media/200/stream" }),
      })),
      works: [],
    }));

    const [chosen] = await revalidatePersistedQueue([{ ...persistedTrack, locationChosen: true }], resolve);

    expect(resolve.mock.calls[0][0][0]).toMatchObject({ locationChosen: true });
    expect(chosen).toMatchObject({ locationId: 200, locationChosen: true, workTitle: "Saved title" });

    // An item already playing from the cache stays there, rather than reload
    // from the local copy and start again from 0:00.
    const [automatic] = await revalidatePersistedQueue(
      [persistedTrack],
      resolver((items) => ({
        items: items.map((item) => ({ ...item, status: "playable", track: serverTrack() })),
        works: [],
      })),
    );
    const [playing] = keepPlayingTrackLocation([automatic], persistedTrack);
    expect(playing).toMatchObject({ locationId: 200, streamUrl: "/api/media/200/stream" });
    expect(playing.playbackKey).not.toBe(automatic.playbackKey);
    expect(keepPlayingTrackLocation([automatic], { ...persistedTrack, locationId: 999 })).toEqual([automatic]);
  });

  it("removes missing and unavailable items and keeps the queue when the library cannot be reached", async () => {
    const queue = [
      { ...persistedTrack, queueItemId: "missing" },
      { ...persistedTrack, queueItemId: "offline", mediaItemId: 12 },
      { ...persistedTrack, queueItemId: "playable", mediaItemId: 13 },
    ];
    const statuses = ["missing", "unavailable", "playable"] as const;
    const restored = await revalidatePersistedQueue(
      queue,
      resolver((items) => ({
        items: items.map((item, index) => ({
          ...item,
          status: statuses[index],
          ...(statuses[index] === "playable" ? { track: serverTrack({ mediaItemId: 13 }) } : {}),
        })),
        works: [],
      })),
    );
    expect(restored.map((track) => track.queueItemId)).toEqual(["playable"]);

    const unreachable = vi.fn<ResolvePlaybackQueue>(async () => {
      throw new Error("offline");
    });
    await expect(revalidatePersistedQueue(queue, unreachable)).resolves.toBe(queue);
  });
});

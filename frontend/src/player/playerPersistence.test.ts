import { describe, expect, it } from "vitest";

import { syntheticWorkCode } from "@/test-support/workCode";
import { discardObsoletePlayerState, loadPersistedQueue, parsePersistedQueue } from "./playerPersistence";
import type { PlayerTrack } from "./playerTypes";

const track = {
  queueItemId: "example-queue-item",
  mediaItemId: 1,
  locationId: 1,
  title: "Example track",
  kind: "audio",
  folderPath: "Main",
  locationType: "local",
  streamUrl: "/api/media/1/stream",
  sizeBytes: null,
  availability: "available",
  workId: 1,
  workCode: syntheticWorkCode("RJ", 0),
  workTitle: "Example Work",
  coverUrl: "",
  circle: "Example Circle",
  progress: null,
  progressRecordable: true,
  lyricsLocationId: null,
  lyricsTitle: "",
} satisfies PlayerTrack;

describe("persisted player state", () => {
  it("migrates legacy end-of-track timers without discarding the queue", () => {
    const restored = parsePersistedQueue(JSON.stringify({ queue: [track], sleepTimer: { mode: "track_end" } }), 1000);
    expect(restored.queue).toEqual([track]);
    expect(restored.sleepTimer).toEqual({
      mode: "deadline",
      deadline: 1000,
      finishCurrentTrack: true,
      waitingForTrackEnd: true,
    });
  });

  it.each([
    { deadline: 900, waitingForTrackEnd: false, keep: false },
    { deadline: 900, waitingForTrackEnd: true, keep: true },
    { deadline: 1100, waitingForTrackEnd: false, keep: true },
  ])("restores timer deadline=$deadline waiting=$waitingForTrackEnd", ({ deadline, waitingForTrackEnd, keep }) => {
    const timer = { mode: "deadline", deadline, finishCurrentTrack: true, waitingForTrackEnd };
    expect(parsePersistedQueue(JSON.stringify({ sleepTimer: timer }), 1000).sleepTimer).toEqual(keep ? timer : null);
  });

  it("drops unplayable entries and stale progress, and normalizes queue preferences", () => {
    const restored = parsePersistedQueue(
      JSON.stringify({
        queue: [
          null,
          { ...track, mediaItemId: 0 },
          { ...track, streamUrl: "" },
          { ...track, progress: { positionSeconds: 20 } },
        ],
        currentIndex: 99,
        mode: "unknown",
        playbackRate: 42,
      }),
    );
    expect(restored).toEqual({ queue: [track], currentIndex: 0, mode: "order", playbackRate: 1, sleepTimer: null });
    expect(parsePersistedQueue("malformed").queue).toEqual([]);
    expect(
      loadPersistedQueue("current-owner", {
        getItem: () => {
          throw new Error("Storage unavailable");
        },
      }).queue,
    ).toEqual([]);
  });

  it("reads only the requested owner and removes obsolete state without touching other owners", () => {
    const data = new Map([
      ["kikoto:player-queue:v1", "unowned"],
      ["kikoto:player-progress:v1", "unowned"],
      ["current-progress", "obsolete"],
      ["current-owner", JSON.stringify({ queue: [track] })],
      ["another-owner", "another user's state"],
    ]);
    discardObsoletePlayerState("current-progress", {
      removeItem: (key) => {
        data.delete(key);
      },
    });
    expect([...data.keys()]).toEqual(["current-owner", "another-owner"]);
    expect(loadPersistedQueue("current-owner", { getItem: (key) => data.get(key) ?? null }).queue).toEqual([track]);
    expect(data.get("another-owner")).toBe("another user's state");
  });
});

import { describe, expect, it } from "vitest";

import type { PlayerTrack, PlayerTrackLocation } from "./playerTypes";
import {
  applyTrackLocation,
  createTrackLocationFailureState,
  recordTrackLocationFailure,
  resetTrackLocationFailures,
} from "./trackLocations";

const locations: PlayerTrackLocation[] = [
  {
    locationId: 11,
    locationType: "local",
    streamUrl: "/api/media/11/stream",
    sourceId: 1,
    sourceName: "Local",
    availability: "available",
  },
  {
    locationId: 12,
    locationType: "cache",
    streamUrl: "/api/media/12/stream",
    sourceId: 2,
    sourceName: "Cache",
    availability: "available",
  },
];

const track: PlayerTrack = {
  queueItemId: "queue-example",
  mediaItemId: 7,
  locationId: 11,
  title: "Example Track",
  kind: "audio",
  folderPath: "",
  locationType: "local",
  streamUrl: "/api/media/11/stream",
  sizeBytes: null,
  availability: "available",
  workId: 1,
  workCode: "RJ00000000",
  workTitle: "Example Work",
  coverUrl: "",
  circle: "Example Circle",
  progress: null,
  progressRecordable: true,
  lyricsLocationId: null,
  lyricsTitle: "",
  locations,
};

describe("track location fallback", () => {
  const fallback = { allowFallback: true };

  it("attempts each location once and emits one terminal result", () => {
    const state = createTrackLocationFailureState();
    const results = [];

    const first = recordTrackLocationFailure(track, state, fallback);
    results.push(first.kind);
    expect(first).toMatchObject({ kind: "switch", location: { locationId: 12 } });
    expect(recordTrackLocationFailure(track, state, fallback)).toEqual({ kind: "ignored" });

    const secondTrack = first.kind === "switch" ? applyTrackLocation(track, first.location) : track;
    results.push(recordTrackLocationFailure(secondTrack, state, fallback).kind);
    results.push(recordTrackLocationFailure(secondTrack, state, fallback).kind);

    expect([...state.failedLocationIds]).toEqual([11, 12]);
    expect(results).toEqual(["switch", "terminal", "ignored"]);
  });

  it("allows a manual source selection to reset prior failures", () => {
    const state = createTrackLocationFailureState();
    recordTrackLocationFailure(track, state, fallback);
    recordTrackLocationFailure(applyTrackLocation(track, locations[1]), state, fallback);

    resetTrackLocationFailures(state);

    expect(recordTrackLocationFailure(track, state, fallback)).toMatchObject({
      kind: "switch",
      location: { locationId: 12 },
    });
  });

  it("stops at the first failure when fallback is disabled", () => {
    const state = createTrackLocationFailureState();

    expect(recordTrackLocationFailure(track, state, { allowFallback: false })).toEqual({ kind: "terminal" });
    expect(recordTrackLocationFailure(track, state, { allowFallback: false })).toEqual({ kind: "ignored" });
  });
});

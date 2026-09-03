import { describe, expect, it } from "vitest";

import type { PlayerTrack } from "@/player/PlayerProvider";
import {
  captureInitialPlaybackTrack,
  playbackTrackMatchesPersistedWork,
  playbackTrackMatchesRemoteWork,
  type PlaybackRouteSnapshot,
} from "./playbackDirectoryRouting";

function playbackTrack(overrides: Partial<PlayerTrack> = {}): PlayerTrack {
  return {
    mediaItemId: 1,
    locationId: 11,
    title: "track.mp3",
    kind: "audio",
    folderPath: "Main",
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
    ...overrides,
  };
}

describe("playback directory routing", () => {
  it("captures an actively playing matching track at detail entry", () => {
    const track = playbackTrack();
    const snapshot = { current: { routeKey: "", track: null } satisfies PlaybackRouteSnapshot };

    expect(captureInitialPlaybackTrack(snapshot, "work:RJ00000000", track, true, true)).toBe(track);
    expect(captureInitialPlaybackTrack(snapshot, "work:RJ00000000", null, false, false)).toBe(track);
  });

  it("keeps the default directory when entry happened while paused", () => {
    const track = playbackTrack();
    const snapshot = { current: { routeKey: "", track: null } satisfies PlaybackRouteSnapshot };

    expect(captureInitialPlaybackTrack(snapshot, "work:RJ00000000", track, false, true)).toBeNull();
    expect(captureInitialPlaybackTrack(snapshot, "work:RJ00000000", track, true, true)).toBeNull();
    expect(captureInitialPlaybackTrack(snapshot, "work:RJ00000001", track, true, true)).toBe(track);
  });

  it("matches persisted logical-work editions by id or normalized code", () => {
    const track = playbackTrack({ workId: 2, workCode: "rj00000001" });
    const work = {
      id: 1,
      primaryCode: "RJ00000000",
      translations: [{ workId: 2, primaryCode: "RJ00000001", locale: "zh-Hans", title: "Example Work 2" }],
    };

    expect(playbackTrackMatchesPersistedWork(track, work, null, "RJ00000000")).toBe(true);
    expect(playbackTrackMatchesPersistedWork(track, null, { id: 2, primaryCode: "RJ00000002" }, "RJ00000002")).toBe(
      true,
    );
    expect(playbackTrackMatchesPersistedWork(track, null, null, "RJ00000002")).toBe(false);
  });

  it("ignores stale persisted detail while a different route is loading", () => {
    const track = playbackTrack({ workId: 1, workCode: "RJ00000000" });
    const staleWork = { id: 1, primaryCode: "RJ00000000", translations: [] };
    const stalePreview = { id: 1, primaryCode: "RJ00000000" };

    expect(playbackTrackMatchesPersistedWork(track, staleWork, stalePreview, "RJ00000001")).toBe(false);
  });

  it("requires the same remote source as well as a matching remote work", () => {
    const track = playbackTrack({
      workId: 0,
      workCode: "RJ00000000",
      remoteSourceId: 7,
      remoteWorkCode: "remote-work-1",
    });

    expect(playbackTrackMatchesRemoteWork(track, null, "remote-work-1", 7)).toBe(true);
    expect(playbackTrackMatchesRemoteWork(track, null, "remote-work-1", 8)).toBe(false);
    expect(playbackTrackMatchesRemoteWork(track, null, "remote-work-2", 7)).toBe(false);
    expect(
      playbackTrackMatchesRemoteWork(
        track,
        { workId: 1, remoteCode: "remote-work-1", primaryCode: "RJ00000000", remoteId: "remote-work-1" },
        "remote-work-2",
        7,
      ),
    ).toBe(false);
  });
});

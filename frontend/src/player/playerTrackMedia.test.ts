import { afterEach, describe, expect, it, vi } from "vitest";

import { audioHlsPlayback } from "./mediaPlayback";
import { playerTrackAudioSource } from "./playerTrackMedia";
import type { PlayerTrack } from "./playerTypes";

const track: PlayerTrack = {
  queueItemId: "queue-example",
  mediaItemId: 7,
  locationId: 11,
  title: "01 Example.wav",
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
};

function stubBrowser({ nativeHls = false, mse = false, userAgent = "Mozilla/5.0 (Windows NT 10.0)" }) {
  vi.stubGlobal("document", {
    createElement: () => ({
      canPlayType: (mime: string) => (nativeHls && mime === "application/vnd.apple.mpegurl" ? "maybe" : ""),
    }),
  });
  vi.stubGlobal("navigator", { userAgent, platform: "Win32", maxTouchPoints: 0 });
  vi.stubGlobal("MediaSource", mse ? { isTypeSupported: (type: string) => type.includes("mp4a.40.2") } : undefined);
}

describe("audio HLS playback support", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the native player on iOS, where it keeps playing on the lock screen", () => {
    stubBrowser({ nativeHls: true, mse: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
    expect(audioHlsPlayback()).toBe("native");
  });

  it("prefers Media Source Extensions elsewhere and falls back to native HLS", () => {
    stubBrowser({ nativeHls: true, mse: true });
    expect(audioHlsPlayback()).toBe("mse");
    stubBrowser({ nativeHls: true });
    expect(audioHlsPlayback()).toBe("native");
    stubBrowser({});
    expect(audioHlsPlayback()).toBeNull();
  });
});

describe("player audio sources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams a file the browser plays directly", () => {
    stubBrowser({ mse: true });
    const source = playerTrackAudioSource(track);
    expect(source.delivery).toBe("direct");
    expect(source.url).toContain("forceDirect=1");
  });

  it("converts compatibility playback and unplayable formats through the HLS playlist", () => {
    stubBrowser({ mse: true });
    expect(playerTrackAudioSource(track, true)).toEqual({
      delivery: "hls",
      url: "/api/media/11/hls/index.m3u8",
    });
    expect(playerTrackAudioSource({ ...track, title: "01 Example.wma" }).delivery).toBe("hls");
  });

  it("prepares a complete conversion without HLS playback or for a video file", () => {
    stubBrowser({});
    const prepared = playerTrackAudioSource(track, true);
    expect(prepared.delivery).toBe("prepared");
    expect(prepared.url).toContain("forceTranscode=1");
    stubBrowser({ mse: true });
    expect(playerTrackAudioSource({ ...track, kind: "video", title: "clip.avi" }).delivery).toBe("prepared");
  });

  it("never converts a remote stream", () => {
    stubBrowser({ mse: true });
    const remote = {
      ...track,
      locationType: "remote_stream",
      remoteSourceId: 3,
      remoteWorkCode: "RJ00000000",
      remotePath: "a.wma",
    };
    expect(playerTrackAudioSource(remote, true).delivery).toBe("direct");
  });
});

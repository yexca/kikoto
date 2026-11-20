import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: { getAudioPlaybackInfo: vi.fn(), getRecordPlayback: vi.fn() } }));

import { api } from "@/lib/api";

import { clearAudioSources, peekAudioSource, resolveAudioSource } from "./audioPlaybackSource";
import { RECORD_LOCATION_TYPE } from "./playerTrackMedia";
import type { PlayerTrack } from "./playerTypes";

const track: PlayerTrack = {
  queueItemId: "queue-example",
  mediaItemId: 7,
  locationId: 11,
  title: "01 Example.mp3",
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

const recordTrack: PlayerTrack = {
  ...track,
  mediaItemId: 0,
  locationId: -21,
  title: "Episode 1.mp3",
  locationType: RECORD_LOCATION_TYPE,
  streamUrl: "/api/records/assets/21/stream",
  workId: 0,
  workCode: "",
  progressRecordable: false,
  record: { assetId: 21, folderId: 4 },
};

function stubBrowser({ mse = true }: { mse?: boolean } = {}) {
  vi.stubGlobal("document", {
    createElement: () => ({ canPlayType: (mime: string) => (mime === "audio/mpeg" ? "probably" : "") }),
  });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 0 });
  vi.stubGlobal("MediaSource", mse ? { isTypeSupported: (type: string) => type.includes("mp4a.40.2") } : undefined);
}

describe("audio sources", () => {
  beforeEach(() => {
    clearAudioSources();
    stubBrowser();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("plays what the server decides, whatever the file name says", async () => {
    const info = vi.spyOn(api, "getAudioPlaybackInfo").mockResolvedValue({
      delivery: "hls",
      url: "/api/media/11/hls/index.m3u8?v=a&profile=audio",
      durationSeconds: 3,
      seekable: true,
    });
    const mislabeled = { ...track, title: "01 Example.mp3" };
    expect(await resolveAudioSource(mislabeled, false)).toEqual({
      delivery: "hls",
      url: "/api/media/11/hls/index.m3u8?v=a&profile=audio",
    });
    expect(info).toHaveBeenCalledWith(
      11,
      { capabilities: ["audio-mp3", "audio-hls"], forceTranscode: false },
      expect.anything(),
    );
  });

  it("asks for compatibility playback and keeps a prepared conversion", async () => {
    const info = vi.mocked(api.getAudioPlaybackInfo).mockResolvedValue({
      delivery: "prepared",
      url: "/api/media/11/stream?profile=audio&forceTranscode=1",
      durationSeconds: 3,
      seekable: true,
    });
    expect((await resolveAudioSource(track, true)).delivery).toBe("prepared");
    expect(info.mock.calls[0][1].forceTranscode).toBe(true);
  });

  it("asks the server once for a track and answers the next request from its decision", async () => {
    const info = vi.spyOn(api, "getAudioPlaybackInfo").mockResolvedValue({
      delivery: "direct",
      url: "/api/media/11/stream?profile=audio",
      durationSeconds: 3,
      seekable: true,
    });
    expect(peekAudioSource(track, false)).toBeNull();
    const [first, second] = await Promise.all([resolveAudioSource(track, false), resolveAudioSource(track, false)]);
    expect(first).toBe(second);
    expect(peekAudioSource(track, false)).toBe(first);
    await resolveAudioSource(track, false);
    expect(info).toHaveBeenCalledTimes(1);
    // Compatibility playback is a different decision.
    expect(peekAudioSource(track, true)).toBeNull();
  });

  it("falls back to the stream route when playback info is unavailable", async () => {
    vi.mocked(api.getAudioPlaybackInfo).mockRejectedValue(new Error("unavailable"));
    const source = await resolveAudioSource(track, false);
    expect(source.delivery).toBe("direct");
    expect(source.url).toContain("/api/media/11/stream");
    expect(source.url).toContain("profile=audio");
    expect(source.url).not.toContain("forceDirect");
    expect(peekAudioSource(track, false)).toBeNull();
    expect((await resolveAudioSource(track, true)).delivery).toBe("prepared");
  });

  it("never converts a remote stream and asks the server nothing", async () => {
    const info = vi.mocked(api.getAudioPlaybackInfo);
    const remote = {
      ...track,
      locationType: "remote_stream",
      remoteSourceId: 3,
      remoteWorkCode: "RJ00000000",
      remotePath: "a.wma",
    };
    const source = peekAudioSource(remote, true);
    expect(source?.delivery).toBe("direct");
    expect(source?.url).toContain("/api/remote-sources/3/works/RJ00000000/media");
    expect(await resolveAudioSource(remote, true)).toBe(source);
    expect(info).not.toHaveBeenCalled();
  });
});

describe("Record audio sources", () => {
  beforeEach(() => {
    clearAudioSources();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks Record's playback info for the audio profile and plays its playlist", async () => {
    stubBrowser();
    const info = vi.mocked(api.getRecordPlayback).mockResolvedValue({
      delivery: "hls",
      conversion: "transcode",
      url: "/api/records/assets/21/hls/index.m3u8?v=a&profile=audio",
      durationSeconds: 3,
      seekable: true,
    });
    expect(await resolveAudioSource(recordTrack, false)).toEqual({
      delivery: "hls",
      url: "/api/records/assets/21/hls/index.m3u8?v=a&profile=audio",
    });
    expect(info).toHaveBeenCalledWith(
      21,
      { capabilities: ["audio-mp3", "audio-hls"], forceTranscode: false, profile: "audio" },
      expect.anything(),
    );
  });

  it("gives a browser without HLS playback the file itself", async () => {
    stubBrowser({ mse: false });
    vi.mocked(api.getRecordPlayback).mockResolvedValue({
      delivery: "hls",
      conversion: "transcode",
      url: "/api/records/assets/21/hls/index.m3u8?v=a&profile=audio",
      durationSeconds: 3,
      seekable: true,
    });
    expect(await resolveAudioSource(recordTrack, true)).toEqual({
      delivery: "direct",
      url: "/api/records/assets/21/stream",
    });
  });

  it("plays the file itself when it plays directly", async () => {
    stubBrowser();
    vi.mocked(api.getRecordPlayback).mockResolvedValue({
      delivery: "direct",
      conversion: "none",
      url: "/api/records/assets/21/stream",
      durationSeconds: 3,
      seekable: true,
    });
    expect(await resolveAudioSource(recordTrack, false)).toEqual({
      delivery: "direct",
      url: "/api/records/assets/21/stream",
    });
  });
});

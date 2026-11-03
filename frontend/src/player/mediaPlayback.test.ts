import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forcePlaybackDirectURL,
  playbackCapabilities,
  playbackURL,
  remoteMediaPlaybackURL,
  remoteMediaURL,
  videoPlaybackCapabilities,
} from "./mediaPlayback";

describe("media playback URLs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds a profile and preserves an existing query and hash", () => {
    const value = playbackURL("/api/media/4/stream?source=local#fragment", "audio", true);
    expect(value).toContain("source=local");
    expect(value).toContain("profile=audio");
    expect(value).toContain("forceTranscode=1");
    expect(value.endsWith("#fragment")).toBe(true);
  });

  it("can request direct extension playback without changing the transcode helper", () => {
    const value = playbackURL("/api/media/4/stream", "audio", false, true);
    expect(value).toContain("forceDirect=1");
    expect(value).not.toContain("forceTranscode=1");
    expect(forcePlaybackDirectURL("/api/media/4/stream?source=local")).toContain("forceDirect=1");
  });

  it("builds a same-origin remote media proxy URL", () => {
    const base = remoteMediaURL(7, "RJ00000001", "Bonus/clip.avi");
    expect(base).toBe("/api/remote-sources/7/works/RJ00000001/media?path=Bonus%2Fclip.avi");
    expect(remoteMediaPlaybackURL(7, "RJ00000001", "Bonus/clip.avi", "video")).toContain("profile=video");
  });

  it("only sends capabilities reported by the media element", () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        canPlayType: (mime: string) => (mime === "audio/mpeg" || mime.includes("mp4a") ? "probably" : ""),
      }),
    });
    expect(playbackCapabilities("audio")).toEqual(["audio-mp3", "audio-mp4-aac"]);
    expect(playbackURL("/media.mp3", "audio")).toContain("capabilities=audio-mp3%2Caudio-mp4-aac");
  });

  it("reports native FLAC and Ogg audio capabilities", () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        canPlayType: (mime: string) => (mime.includes("flac") || mime.includes("ogg") ? "probably" : ""),
      }),
    });
    expect(playbackCapabilities("audio")).toEqual(["audio-flac", "audio-ogg-opus", "audio-ogg-vorbis"]);
  });
});

describe("video playback capabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A device that plays H.264 High, HEVC Main in hvc1 with AAC, and AV1 in WebM.
  function stubVideoElement() {
    const playable = [
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'video/mp4; codecs="avc1.4D401F"',
      'video/mp4; codecs="avc1.64002A"',
      'video/mp4; codecs="hvc1.1.6.L93.B0, mp4a.40.2"',
      'video/mp4; codecs="hvc1.1.6.L123.B0"',
      'video/mp4; codecs="hvc1.2.4.L123.B0"',
      'video/webm; codecs="av01.0.04M.08, opus"',
      'video/mp4; codecs="av01.0.09M.08"',
    ];
    vi.stubGlobal("document", {
      createElement: () => ({ canPlayType: (mime: string) => (playable.includes(mime) ? "probably" : "") }),
    });
  }

  it("keeps HEVC and AV1 decoder keys only when decoding is supported and power efficient", async () => {
    stubVideoElement();
    const decodingInfo = vi.fn(async ({ video }: MediaDecodingConfiguration) => ({
      supported: true,
      smooth: true,
      powerEfficient: video?.contentType.includes("hvc1.1.6") ?? false,
    }));
    vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo } });

    await expect(videoPlaybackCapabilities()).resolves.toEqual([
      "video-mp4-h264-aac",
      "video-mp4-hvc1-aac",
      "video-webm-av1-opus",
      "video-h264-main",
      "video-h264-high",
      "video-hevc-main",
    ]);
    expect(decodingInfo).toHaveBeenCalledWith({
      type: "file",
      video: {
        contentType: 'video/mp4; codecs="hvc1.1.6.L123.B0"',
        width: 1920,
        height: 1080,
        bitrate: 10_000_000,
        framerate: 30,
      },
    });
    // Keys that the media element already rejects are never measured.
    expect(decodingInfo).toHaveBeenCalledTimes(3);
  });

  it("drops a decoder key whose decoding check fails", async () => {
    stubVideoElement();
    vi.stubGlobal("navigator", {
      mediaCapabilities: { decodingInfo: () => Promise.reject(new TypeError("unsupported configuration")) },
    });
    const capabilities = await videoPlaybackCapabilities();
    expect(capabilities).not.toContain("video-hevc-main");
    expect(capabilities).not.toContain("video-av1-main");
    expect(capabilities).toContain("video-h264-high");
  });

  it("trusts the media element where MediaCapabilities is missing", async () => {
    stubVideoElement();
    vi.stubGlobal("navigator", {});
    const capabilities = await videoPlaybackCapabilities();
    expect(capabilities).toEqual(expect.arrayContaining(["video-hevc-main", "video-hevc-main10", "video-av1-main"]));
    expect(playbackCapabilities("video")).toEqual(capabilities);
  });

  function stubMediaSource(supported: string[]) {
    vi.stubGlobal("MediaSource", { isTypeSupported: (mime: string) => supported.includes(mime) });
  }

  it("keeps HLS HEVC keys only when Media Source decoding is supported and power efficient", async () => {
    stubVideoElement();
    stubMediaSource([
      'audio/mp4; codecs="mp4a.40.2"',
      'video/mp4; codecs="hvc1.1.6.L123.B0"',
      'video/mp4; codecs="hvc1.2.4.L123.B0"',
    ]);
    // HEVC Main is efficient as a file and through Media Source, Main 10 only through Media Source.
    const decodingInfo = vi.fn(async ({ type, video }: MediaDecodingConfiguration) => ({
      supported: true,
      smooth: true,
      powerEfficient:
        (video?.contentType.includes("hvc1.1.6") ?? false) ||
        (type === "media-source" && (video?.contentType.includes("hvc1.2.4") ?? false)),
    }));
    vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo } });

    const capabilities = await videoPlaybackCapabilities();
    expect(capabilities).toEqual(
      expect.arrayContaining(["video-hevc-main", "video-hls-hevc-main", "video-hls-hevc-main10"]),
    );
    expect(capabilities).not.toContain("video-hevc-main10");
    // Keys that Media Source rejects are never measured.
    expect(capabilities).not.toContain("video-hls-hevc-main-l51");
    expect(decodingInfo).toHaveBeenCalledWith({
      type: "media-source",
      video: {
        contentType: 'video/mp4; codecs="hvc1.1.6.L123.B0"',
        width: 1920,
        height: 1080,
        bitrate: 10_000_000,
        framerate: 30,
      },
    });
    expect(decodingInfo.mock.calls.filter(([config]) => config.type === "media-source")).toHaveLength(2);
  });

  it("offers no HLS HEVC key without Media Source AAC or with inefficient decoding", async () => {
    stubVideoElement();
    stubMediaSource(['video/mp4; codecs="hvc1.1.6.L123.B0"']);
    vi.stubGlobal("navigator", {});
    expect(await videoPlaybackCapabilities()).not.toContain("video-hls-hevc-main");

    stubMediaSource(['audio/mp4; codecs="mp4a.40.2"', 'video/mp4; codecs="hvc1.1.6.L123.B0"']);
    expect(await videoPlaybackCapabilities()).toContain("video-hls-hevc-main");
    vi.stubGlobal("navigator", {
      mediaCapabilities: { decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: false }) },
    });
    expect(await videoPlaybackCapabilities()).not.toContain("video-hls-hevc-main");
  });

  it("leaves unverified decoder keys out of the synchronous list", () => {
    stubVideoElement();
    vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo: vi.fn() } });
    expect(playbackCapabilities("video")).toEqual([
      "video-mp4-h264-aac",
      "video-mp4-hvc1-aac",
      "video-webm-av1-opus",
      "video-h264-main",
      "video-h264-high",
    ]);
  });
});

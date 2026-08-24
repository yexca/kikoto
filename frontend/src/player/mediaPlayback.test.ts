import { afterEach, describe, expect, it, vi } from "vitest";

import { playbackCapabilities, playbackURL, remoteMediaPlaybackURL, remoteMediaURL } from "./mediaPlayback";

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

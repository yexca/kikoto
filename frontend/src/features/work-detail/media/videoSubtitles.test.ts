import { describe, expect, it } from "vitest";

import { videoSubtitlesFor, videoSubtitleWebVtt } from "@/features/work-detail/media/videoSubtitles";
import type { LyricsChoice } from "@/player/lyricsMatching";

function choice(locationId: number, path: string, reason: LyricsChoice["reason"] = "same_stem"): LyricsChoice {
  return { mediaItemId: locationId, locationId, title: path.split("/").pop() ?? path, path, reason };
}

describe("video sidecar subtitles", () => {
  it("loads same-name WebVTT and SRT files from the video's folder", () => {
    const choices = [
      choice(1, "movie/clip.vtt"),
      choice(2, "movie/Clip.mp4.srt", "exact_sidecar"),
      choice(3, "movie/clip.lrc"),
      choice(4, "other/clip.srt"),
      choice(5, "movie/clip-commentary.vtt", "normalized_name"),
      choice(6, "movie/subtitles.vtt", "shared_folder"),
    ];
    expect(videoSubtitlesFor("movie/clip.mp4", choices).map((subtitle) => subtitle.locationId)).toEqual([1, 2]);
  });

  it("matches the tree's display path and keeps a remote file's URL", () => {
    const remote = { ...choice(-2, "raw/clip.srt"), displayPath: "movie/clip.srt", url: "/remote/clip.srt" };
    expect(videoSubtitlesFor("movie/clip.mp4", [remote])).toEqual([
      { locationId: -2, title: "clip.srt", url: "/remote/clip.srt" },
    ]);
  });
});

describe("subtitle conversion", () => {
  it("rewrites SRT cues as WebVTT and keeps their line breaks", () => {
    const srt =
      "1\r\n00:00:01,500 --> 00:00:04,000\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n01:02:03,040 --> 01:02:05,000\r\nLater\r\n";
    expect(videoSubtitleWebVtt(srt)).toBe(
      "WEBVTT\n\n00:00:01.500 --> 00:00:04.000\n<i>Hello</i>\nthere\n\n01:02:03.040 --> 01:02:05.000\nLater\n",
    );
  });

  it("ends a cue without a usable end at the next cue", () => {
    const srt =
      "1\n00:00:01,000 --> 00:00:00,000\nFirst\n\n2\n00:00:03,000 -->\nSecond\n\n3\n00:00:09,000 --> 00:00:10,000\n\n";
    expect(videoSubtitleWebVtt(srt)).toBe(
      "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFirst\n\n00:00:03.000 --> 00:00:09.000\nSecond\n",
    );
  });

  it("keeps a WebVTT file as written and rejects a file without cues", () => {
    const vtt = "\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000 line:0\n<c.yellow>Hi</c>\n";
    expect(videoSubtitleWebVtt(vtt)).toBe(vtt.slice(1));
    expect(videoSubtitleWebVtt("just some notes")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  initialVideoSubtitleKey,
  subtitleLanguageName,
  videoSubtitlesFor,
  videoSubtitleTracks,
} from "@/player/video/videoSubtitles";
import type { VideoEmbeddedSubtitle } from "@/lib/api";
import type { LyricsChoice } from "@/player/lyricsMatching";

function choice(locationId: number, path: string, reason: LyricsChoice["reason"] = "same_stem"): LyricsChoice {
  return { mediaItemId: locationId, locationId, title: path.split("/").pop() ?? path, path, reason };
}

describe("video sidecar subtitles", () => {
  it("loads same-name WebVTT, SRT, ASS, and SSA files from the video's folder", () => {
    const choices = [
      choice(1, "movie/clip.vtt"),
      choice(2, "movie/Clip.mp4.srt", "exact_sidecar"),
      choice(3, "movie/clip.lrc"),
      choice(4, "other/clip.srt"),
      choice(5, "movie/clip-commentary.vtt", "normalized_name"),
      choice(6, "movie/subtitles.vtt", "shared_folder"),
      choice(7, "movie/clip.ass"),
      choice(8, "movie/clip.mp4.SSA", "exact_sidecar"),
    ];
    expect(videoSubtitlesFor("movie/clip.mp4", choices).map((subtitle) => subtitle.locationId)).toEqual([1, 2, 7, 8]);
  });

  it("matches the tree's display path and keeps a remote file's URL", () => {
    const remote = { ...choice(-2, "raw/clip.srt"), displayPath: "movie/clip.srt", url: "/remote/clip.srt" };
    expect(videoSubtitlesFor("movie/clip.mp4", [remote])).toEqual([
      { locationId: -2, title: "clip.srt", url: "/remote/clip.srt" },
    ]);
  });
});

describe("video subtitle tracks", () => {
  const labels = {
    languageName: (tag: string) => subtitleLanguageName(tag, "en"),
    untitled: (position: number) => `Subtitle ${position}`,
    forced: (label: string) => `${label} (forced)`,
  };
  function stream(index: number, fields: Partial<VideoEmbeddedSubtitle> = {}): VideoEmbeddedSubtitle {
    return {
      stream: index,
      codec: "subrip",
      default: false,
      forced: false,
      url: `/api/media/1/subtitles/${index}.vtt?v=revision`,
      ...fields,
    };
  }

  it("lists sidecar files, then embedded streams labelled by language and title", () => {
    const tracks = videoSubtitleTracks(
      [{ locationId: 4, title: "clip.ass" }],
      [
        stream(2, { language: "jpn", title: "Dialogue" }),
        stream(3, { language: "eng", forced: true }),
        stream(4, { title: "Commentary" }),
        stream(5, { language: "und" }),
        stream(6, { language: "not a language!" }),
      ],
      labels,
    );
    expect(tracks.map((track) => [track.key, track.label, track.language])).toEqual([
      ["file:4:", "clip.ass", undefined],
      ["stream:2", "Japanese · Dialogue", "ja"],
      ["stream:3", "English (forced)", "en"],
      ["stream:4", "Commentary", undefined],
      ["stream:5", "Subtitle 4", undefined],
      ["stream:6", "Subtitle 5", undefined],
    ]);
    expect(tracks[1]).toMatchObject({ kind: "embedded", url: "/api/media/1/subtitles/2.vtt?v=revision" });
  });

  it("shows a forced stream, then a default stream, then the first track", () => {
    const sidecar = [{ locationId: 4, title: "clip.vtt" }];
    const embedded = [stream(2, { default: true }), stream(3, { forced: true })];
    const key = (streams: VideoEmbeddedSubtitle[]) =>
      initialVideoSubtitleKey(videoSubtitleTracks(sidecar, streams, labels), streams);
    expect(key(embedded)).toBe("stream:3");
    expect(key([stream(2), stream(3, { default: true })])).toBe("stream:3");
    expect(key([stream(2)])).toBe("file:4:");
    expect(initialVideoSubtitleKey([], [])).toBeUndefined();
  });
});

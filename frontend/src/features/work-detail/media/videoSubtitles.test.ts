import { describe, expect, it } from "vitest";

import {
  initialVideoSubtitleKey,
  subtitleLanguageName,
  videoSubtitlesFor,
  videoSubtitleTracks,
  videoSubtitleWebVtt,
} from "@/features/work-detail/media/videoSubtitles";
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

describe("subtitle conversion", () => {
  it("rewrites SRT cues as WebVTT and keeps their line breaks", () => {
    const srt =
      "1\r\n00:00:01,500 --> 00:00:04,000\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n01:02:03,040 --> 01:02:05,000\r\nLater\r\n";
    expect(videoSubtitleWebVtt(srt)).toBe(
      "WEBVTT\n\n00:00:01.500 --> 00:00:04.000\n<i>Hello</i>\nthere\n\n01:02:03.040 --> 01:02:05.000\nLater\n",
    );
  });

  it("shows SRT text as written, keeping only the markup WebVTT shares", () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\n<font color="#ffff00">Tom & Jerry</font> <B>love</B> <3\nif a < b --> c > d\n';
    expect(videoSubtitleWebVtt(srt)).toBe(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTom &amp; Jerry <b>love</b> &lt;3\nif a &lt; b --&gt; c &gt; d\n",
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

describe("ASS subtitle conversion", () => {
  it("keeps the timing and text of ASS dialogue", () => {
    const ass = [
      "\uFEFF[Script Info]",
      "Title: Synthetic",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize",
      "Style: Default,Arial,20",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not shown",
      "Dialogue: 0,0:00:05.50,0:00:07.00,Default,,0,0,0,,{\\an8}second, with a comma",
      "Dialogue: 0,0:00:01.25,0:00:03.00,Default,,0,0,0,,{\\i1}first{\\i0}\\Nline\\nthree\\hwords",
      "Dialogue: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,a < b & c --> d",
      "Dialogue: 0,1:02:03.00,1:02:04.00,Default,,0,0,0,,{\\p1}{\\p0}",
    ].join("\r\n");
    expect(videoSubtitleWebVtt(ass)).toBe(
      [
        "WEBVTT",
        "",
        "00:00:01.250 --> 00:00:03.000",
        "first",
        "line",
        "three words",
        "",
        "00:00:05.500 --> 00:00:07.000",
        "second, with a comma",
        "",
        "00:00:08.000 --> 00:00:09.000",
        "a &lt; b &amp; c --&gt; d",
        "",
      ].join("\n"),
    );
  });

  it("reads SSA dialogue in its declared field order", () => {
    const ssa =
      "[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
      "Dialogue: Marked=0,0:00:02.00,0:00:04.50,Default,,0000,0000,0000,,old style";
    expect(videoSubtitleWebVtt(ssa)).toBe("WEBVTT\n\n00:00:02.000 --> 00:00:04.500\nold style\n");
  });

  it("rejects an ASS file without dialogue", () => {
    expect(videoSubtitleWebVtt("[Script Info]\nTitle: Synthetic\n\n[Events]\n")).toBeNull();
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

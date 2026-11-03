import { describe, expect, it } from "vitest";

import i18n, { ensureUiLocale } from "@/i18n";
import {
  chooseVideoAudioStream,
  chosenVideoAudioStream,
  forgetChosenVideoAudioStream,
  rejectsVideoAudioStream,
  videoAudioTrackChoices,
  videoAudioTrackLabel,
} from "@/features/work-detail/media/videoAudioTracks";
import type { VideoAudioTrack } from "@/lib/api";

const japanese: VideoAudioTrack = { streamIndex: 1, codec: "aac", channels: 2, language: "jpn", default: true };
const commentary: VideoAudioTrack = {
  streamIndex: 3,
  codec: "ac3",
  channels: 6,
  language: "eng",
  title: "Commentary",
  default: false,
};

describe("video audio tracks", () => {
  it("offers a choice only for two tracks or more", () => {
    expect(videoAudioTrackChoices(null)).toEqual([]);
    expect(videoAudioTrackChoices({})).toEqual([]);
    expect(videoAudioTrackChoices({ audioTracks: [japanese] })).toEqual([]);
    expect(videoAudioTrackChoices({ audioTracks: [japanese, commentary] })).toEqual([japanese, commentary]);
  });

  it("names a track by position, title, language, and channel layout", async () => {
    const t = i18n.getFixedT("en");
    expect(videoAudioTrackLabel(japanese, 0, t, "en")).toBe("Track 1 · Japanese · Stereo");
    expect(videoAudioTrackLabel(commentary, 1, t, "en")).toBe("Track 2 · Commentary · English · 5.1");
    expect(videoAudioTrackLabel({ streamIndex: 4, codec: "opus", default: false }, 2, t, "en")).toBe("Track 3");
    expect(videoAudioTrackLabel({ ...japanese, language: "qaa", channels: 3 }, 0, t, "en")).toBe(
      "Track 1 · qaa · 3 channels",
    );
    await ensureUiLocale("ja");
    expect(videoAudioTrackLabel(japanese, 0, i18n.getFixedT("ja"), "ja")).toBe("トラック 1 · 日本語 · ステレオ");
  });

  it("remembers a chosen track per user and file for the page session", () => {
    expect(chosenVideoAudioStream(7, 11)).toBeNull();
    chooseVideoAudioStream(7, 11, 3);
    expect(chosenVideoAudioStream(7, 11)).toBe(3);
    expect(chosenVideoAudioStream(8, 11)).toBeNull();
    expect(chosenVideoAudioStream(7, 12)).toBeNull();
    forgetChosenVideoAudioStream(7, 11);
    expect(chosenVideoAudioStream(7, 11)).toBeNull();
  });

  it("recognizes a choice the server no longer accepts", () => {
    expect(rejectsVideoAudioStream(Object.assign(new Error("Invalid"), { code: "invalid_audio_stream" }))).toBe(true);
    expect(rejectsVideoAudioStream(Object.assign(new Error("Busy"), { code: "media_probe_busy" }))).toBe(false);
    expect(rejectsVideoAudioStream(null)).toBe(false);
  });
});

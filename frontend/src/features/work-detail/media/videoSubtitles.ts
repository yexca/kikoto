import type { VideoEmbeddedSubtitle } from "@/lib/api";
import { parseAssCues, parseTimedCues, timedCuesToWebVtt } from "@/lib/timedLyrics";
import { sidecarSubtitleChoices, type LyricsChoice } from "@/player/lyricsMatching";

/** A subtitle file beside a video: a local location, or a remote file read through `url`. */
export type VideoSubtitle = {
  locationId: number;
  title: string;
  url?: string;
};

/** The same-name WebVTT, SRT, ASS, and SSA files that a video preview loads as subtitle tracks. */
export function videoSubtitlesFor(videoPath: string, choices: LyricsChoice[]): VideoSubtitle[] {
  return sidecarSubtitleChoices(videoPath, choices).map((choice) => ({
    locationId: choice.locationId,
    title: choice.title,
    ...(choice.url ? { url: choice.url } : {}),
  }));
}

/**
 * A subtitle file as WebVTT for a `<track>` element: a WebVTT file stays as it
 * is, keeping its cue settings and styling, SRT cues are rewritten, and ASS or
 * SSA dialogue keeps only its timing and text. Null when the file holds no cue.
 */
export function videoSubtitleWebVtt(text: string) {
  const content = text.replace(/^﻿/, "");
  if (/^WEBVTT(?:[ \t]|\r?\n|$)/.test(content)) return content;
  const cues = /^[ \t]*\[(?:Script Info|Events)\][ \t]*$/im.test(content)
    ? parseAssCues(content)
    : parseTimedCues(content).map((cue) => ({ ...cue, lines: cue.lines.map(srtCueTextToWebVtt) }));
  return cues.some((cue) => cue.lines.length > 0) ? timedCuesToWebVtt(cues) : null;
}

const srtTagPattern = /(<\/?[a-zA-Z][^<>]*>)/;
const webVttSharedTagPattern = /^<(\/?)([ibu])>$/i;

/**
 * One line of SRT cue text as WebVTT cue text: the `<i>`, `<b>`, and `<u>`
 * markup the formats share is kept, other tags such as `<font>` are dropped,
 * and every other `<`, `>`, and `&` is escaped so it shows as written.
 */
function srtCueTextToWebVtt(line: string) {
  return line
    .split(srtTagPattern)
    .map((part, index) => {
      if (index % 2 === 1) {
        const shared = webVttSharedTagPattern.exec(part);
        return shared ? `<${shared[1]}${shared[2].toLowerCase()}>` : "";
      }
      return part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    })
    .join("");
}

/** A subtitle track of the video element: a sidecar file, or an embedded stream the server extracts. */
export type VideoSubtitleTrack = {
  key: string;
  label: string;
  /** A BCP 47 tag for the track's `srclang`, when the stream declares a language. */
  language?: string;
} & ({ kind: "sidecar"; subtitle: VideoSubtitle } | { kind: "embedded"; url: string });

export type VideoSubtitleLabels = {
  languageName: (tag: string) => string;
  /** Names a stream that declares neither a language nor a title, by its 1-based position. */
  untitled: (position: number) => string;
  forced: (label: string) => string;
};

/**
 * The subtitle tracks of a video: its sidecar files in file order, then its
 * embedded text streams in stream order. An embedded stream is labelled by its
 * language and title.
 */
export function videoSubtitleTracks(
  sidecars: VideoSubtitle[],
  embedded: VideoEmbeddedSubtitle[],
  labels: VideoSubtitleLabels,
): VideoSubtitleTrack[] {
  const tracks: VideoSubtitleTrack[] = sidecars.map((subtitle) => ({
    key: sidecarSubtitleKey(subtitle),
    label: subtitle.title,
    kind: "sidecar",
    subtitle,
  }));
  embedded.forEach((stream, position) => {
    const language = subtitleLanguageTag(stream.language);
    const title = stream.title?.trim() ?? "";
    const languageName = language ? labels.languageName(language) : "";
    const name =
      [languageName, title].filter((part, index, parts) => part && parts.indexOf(part) === index).join(" · ") ||
      labels.untitled(position + 1);
    tracks.push({
      key: `stream:${stream.stream}`,
      label: stream.forced ? labels.forced(name) : name,
      ...(language ? { language } : {}),
      kind: "embedded",
      url: stream.url,
    });
  });
  return tracks;
}

export function sidecarSubtitleKey(subtitle: VideoSubtitle) {
  return `file:${subtitle.locationId}:${subtitle.url ?? ""}`;
}

/**
 * The track that shows first: an embedded stream marked forced, then one
 * marked default, then the first track.
 */
export function initialVideoSubtitleKey(tracks: VideoSubtitleTrack[], embedded: VideoEmbeddedSubtitle[]) {
  const flagged = (flag: "forced" | "default") => embedded.find((stream) => stream[flag]);
  const preferred = flagged("forced") ?? flagged("default");
  return preferred ? `stream:${preferred.stream}` : tracks[0]?.key;
}

/** A stream's declared language as a canonical BCP 47 tag, such as `ja` for `jpn`. */
function subtitleLanguageTag(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || /^(?:und|zxx|mis|mul)$/i.test(trimmed)) return undefined;
  try {
    return Intl.getCanonicalLocales(trimmed)[0];
  } catch {
    return undefined;
  }
}

/** The name of a language tag in the interface language, or the tag itself. */
export function subtitleLanguageName(tag: string, locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(tag) || tag;
  } catch {
    return tag;
  }
}

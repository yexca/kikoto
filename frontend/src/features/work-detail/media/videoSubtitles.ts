import { parseTimedCues, timedCuesToWebVtt } from "@/lib/timedLyrics";
import { sidecarSubtitleChoices, type LyricsChoice } from "@/player/lyricsMatching";

/** A subtitle file beside a video: a local location, or a remote file read through `url`. */
export type VideoSubtitle = {
  locationId: number;
  title: string;
  url?: string;
};

/** The same-name WebVTT and SRT files that a video preview loads as subtitle tracks. */
export function videoSubtitlesFor(videoPath: string, choices: LyricsChoice[]): VideoSubtitle[] {
  return sidecarSubtitleChoices(videoPath, choices).map((choice) => ({
    locationId: choice.locationId,
    title: choice.title,
    ...(choice.url ? { url: choice.url } : {}),
  }));
}

/**
 * A subtitle file as WebVTT for a `<track>` element: a WebVTT file stays as it
 * is, keeping its cue settings and styling, and SRT cues are rewritten. Null
 * when the file holds no cue.
 */
export function videoSubtitleWebVtt(text: string) {
  const content = text.replace(/^\uFEFF/, "");
  if (/^WEBVTT(?:[ \t]|\r?\n|$)/.test(content)) return content;
  const cues = parseTimedCues(content);
  return cues.some((cue) => cue.lines.length > 0) ? timedCuesToWebVtt(cues) : null;
}

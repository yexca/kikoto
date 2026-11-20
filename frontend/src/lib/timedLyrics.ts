// Timed lyrics as the server reads them. The server parses LRC, WebVTT, SRT, and
// ASS files (`/api/media/{id}/text?format=lyrics`, `/api/lyrics/parse`), so the
// client only looks up the active line, moves the lines by the listener's
// offset, and shows them.

export type TimedLyricLine = {
  /** Seconds from the start of the track; a line moved before the start keeps its negative time. */
  time: number;
  text: string;
  /** Marks the line naming the models that wrote AI-made lyrics; it is not one of their lines. */
  attribution?: boolean;
};

export type ParsedLyrics = {
  timed: boolean;
  lines: TimedLyricLine[];
};

export const untimedLyrics: ParsedLyrics = { timed: false, lines: [] };

export function activeTimedLyricIndex(lines: TimedLyricLine[], currentTime: number) {
  if (lines.length === 0) return -1;
  let active = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].time > currentTime + 0.15) break;
    active = index;
  }
  return active;
}

/**
 * Moves every timed line by the listener's offset; a positive offset shows each
 * line later. The active line, a seek to a line, and a native lyrics surface
 * all read the moved times. A line moved before the start keeps its own
 * negative time, so the lines stay distinct and in order and the line current
 * at the start is the last of them.
 */
export function offsetTimedLyrics(parsed: ParsedLyrics, offsetMs: number): ParsedLyrics {
  if (!parsed.timed || !offsetMs) return parsed;
  const offsetSeconds = offsetMs / 1000;
  return {
    timed: true,
    lines: parsed.lines.map((line) => ({ ...line, time: line.time + offsetSeconds })),
  };
}

/**
 * The first line playback can reach: the line active at the start. Lines before
 * it have already passed when the track begins, so they cannot become active
 * and a seek cannot land on them.
 */
export function firstReachableLyricIndex(lines: TimedLyricLine[]) {
  return activeTimedLyricIndex(lines, 0);
}

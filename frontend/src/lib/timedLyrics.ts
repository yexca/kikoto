export type TimedLyricLine = {
  time: number;
  text: string;
};

export type ParsedLyrics = {
  timed: boolean;
  lines: TimedLyricLine[];
};

// An LRC tag is `[mm:ss]` with an optional fraction after `.` or `:`, where the
// minute count is unbounded so a track longer than 99 minutes stays timed. A tag
// with an hour field is `[hh:mm:ss.fff]`; its fraction must follow a `.` so that
// `[mm:ss:ff]` keeps meaning minutes, seconds, and a fraction.
const lrcTimestampSource = String.raw`\[(?:(\d+):(\d{1,2}):(\d{2})\.(\d{1,3})|(\d+):(\d{2})(?:[.:](\d{1,3}))?)\]`;
const lrcTimestampPattern = new RegExp(lrcTimestampSource, "g");
const lrcLineStartPattern = new RegExp(`^${lrcTimestampSource}`);

/** Whether a line begins with an LRC timestamp tag. */
export function startsWithLrcTimestamp(line: string) {
  return lrcLineStartPattern.test(line);
}

export function parseTimedLyrics(text: string): ParsedLyrics {
  const lrcLines: TimedLyricLine[] = [];
  const sourceLines = text.split(/\r?\n/);
  for (const rawLine of sourceLines) {
    const timestamps = Array.from(rawLine.matchAll(lrcTimestampPattern));
    if (timestamps.length === 0) continue;
    const lineText = rawLine.replace(/\[[^\]]+\]/g, "").trim();
    for (const match of timestamps) {
      const time =
        match[1] !== undefined
          ? Number(match[1]) * 3600 + timestampToSeconds(match[2], match[3], match[4])
          : timestampToSeconds(match[5], match[6], match[7]);
      lrcLines.push({ time, text: lineText });
    }
  }
  if (lrcLines.length > 0) {
    return { timed: true, lines: lrcLines.sort((left, right) => left.time - right.time) };
  }

  const assLines = parseAssDialogue(sourceLines);
  if (assLines.length > 0) {
    return { timed: true, lines: assLines.sort((left, right) => left.time - right.time) };
  }

  const cueLines = parseCueBlocks(sourceLines).map((cue) => ({ time: cue.start, text: cue.lines.join(" ") }));
  return cueLines.length > 0
    ? { timed: true, lines: cueLines.sort((left, right) => left.time - right.time) }
    : { timed: false, lines: [] };
}

/** A WebVTT or SRT cue: its start, its end when the timing line gives one, and its text lines. */
export type TimedCue = {
  start: number;
  end: number | null;
  lines: string[];
};

const cueTimestampSource = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?`;
const cueTimingPattern = new RegExp(`(${cueTimestampSource})\\s*-->(?:\\s*(${cueTimestampSource}))?`);

/** The cues of a WebVTT or SRT file in file order. */
export function parseTimedCues(text: string): TimedCue[] {
  return parseCueBlocks(text.split(/\r?\n/));
}

function parseCueBlocks(sourceLines: string[]): TimedCue[] {
  const cues: TimedCue[] = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const match = cueTimingPattern.exec(sourceLines[index]);
    if (!match) continue;
    const lines: string[] = [];
    index += 1;
    while (index < sourceLines.length && sourceLines[index].trim() !== "") {
      lines.push(sourceLines[index].trim());
      index += 1;
    }
    cues.push({
      start: cueTimestampToSeconds(match[1]),
      end: match[2] ? cueTimestampToSeconds(match[2]) : null,
      lines,
    });
  }
  return cues;
}

// A cue whose timing line names no usable end shows until the next cue, or this long.
const fallbackCueSeconds = 5;

/**
 * Writes cues as a WebVTT file, the one subtitle format every browser's
 * `<track>` element reads. Cue lines are written as given, already in WebVTT
 * cue text, and keep their line breaks.
 */
export function timedCuesToWebVtt(cues: TimedCue[]) {
  const blocks = ["WEBVTT"];
  cues.forEach((cue, index) => {
    const lines = cue.lines.map((line) => line.replace(/-->/g, "--&gt;"));
    if (lines.length === 0) return;
    const next = cues.slice(index + 1).find((candidate) => candidate.start > cue.start)?.start;
    const end = cue.end !== null && cue.end > cue.start ? cue.end : (next ?? cue.start + fallbackCueSeconds);
    blocks.push(`${webVttTimestamp(cue.start)} --> ${webVttTimestamp(end)}\n${lines.join("\n")}`);
  });
  return `${blocks.join("\n\n")}\n`;
}

function webVttTimestamp(seconds: number) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export function activeTimedLyricIndex(lines: TimedLyricLine[], currentTime: number) {
  if (lines.length === 0) return -1;
  let active = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].time > currentTime + 0.15) break;
    active = index;
  }
  return active;
}

// The [Events] fields of an ASS or SSA subtitle when the file declares no
// Format line; Text is always last and may itself contain commas.
const defaultAssEventFields = [
  "layer",
  "start",
  "end",
  "style",
  "name",
  "marginl",
  "marginr",
  "marginv",
  "effect",
  "text",
];
const assTimePattern = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;

type AssDialogue = { start: number; end: number | null; text: string };

/**
 * The Dialogue events of an ASS or SSA subtitle in file order, with the raw
 * text of each, which may still hold override tags and escapes.
 */
function parseAssEvents(sourceLines: string[]): AssDialogue[] {
  let fields = defaultAssEventFields;
  const events: AssDialogue[] = [];
  for (const rawLine of sourceLines) {
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const kind = line.slice(0, separator).trim().toLowerCase();
    const body = line.slice(separator + 1).trim();
    if (kind === "format") {
      const declared = body.split(",").map((field) => field.trim().toLowerCase());
      if (declared.includes("start") && declared[declared.length - 1] === "text") fields = declared;
      continue;
    }
    if (kind !== "dialogue") continue;
    const values = body.split(",");
    if (values.length < fields.length) continue;
    const start = assTimestampToSeconds(values[fields.indexOf("start")]?.trim() ?? "");
    if (start === null) continue;
    const endIndex = fields.indexOf("end");
    const end = endIndex < 0 ? null : assTimestampToSeconds(values[endIndex]?.trim() ?? "");
    events.push({ start, end, text: values.slice(fields.length - 1).join(",") });
  }
  return events;
}

/**
 * The lines of ASS dialogue text: override tags such as `{\an8}` are dropped,
 * `\N` and `\n` break the line, and `\h` is a space.
 */
function assTextLines(text: string) {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\h/g, " ")
    .split(/\\[Nn]/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

/** Reads the Dialogue lines of an ASS or SSA subtitle as timed lines, each on one line. */
function parseAssDialogue(sourceLines: string[]): TimedLyricLine[] {
  return parseAssEvents(sourceLines).flatMap((event) => {
    const text = assTextLines(event.text).join(" ");
    return text ? [{ time: event.start, text }] : [];
  });
}

/**
 * The Dialogue lines of an ASS or SSA subtitle as cues in start order, keeping
 * only their timing and text. Styles and positions are dropped, and the text
 * is escaped so a `<` or `&` in it shows as written in WebVTT.
 */
export function parseAssCues(text: string): TimedCue[] {
  return parseAssEvents(text.split(/\r?\n/))
    .map((event) => ({
      start: event.start,
      end: event.end,
      lines: assTextLines(event.text).map((line) =>
        line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      ),
    }))
    .filter((cue) => cue.lines.length > 0)
    .sort((left, right) => left.start - right.start);
}

function assTimestampToSeconds(value: string) {
  const match = assTimePattern.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + timestampToSeconds(match[2], match[3], match[4]);
}

function timestampToSeconds(minutes: string, seconds: string, fraction = "0") {
  const normalizedFraction = Number(`0.${fraction.padEnd(3, "0").slice(0, 3)}`);
  return Number(minutes) * 60 + Number(seconds) + normalizedFraction;
}

function cueTimestampToSeconds(value: string) {
  const parts = value.replace(",", ".").split(":");
  const secondsPart = Number(parts.pop() ?? 0);
  const minutesPart = Number(parts.pop() ?? 0);
  const hoursPart = Number(parts.pop() ?? 0);
  return hoursPart * 3600 + minutesPart * 60 + secondsPart;
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

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

  const cueLines: TimedLyricLine[] = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const match = sourceLines[index].match(/(\d{1,2}:)?(\d{1,2}):(\d{2})([,.]\d{1,3})?\s*-->/);
    if (!match) continue;
    const textLines: string[] = [];
    index += 1;
    while (index < sourceLines.length && sourceLines[index].trim() !== "") {
      textLines.push(sourceLines[index].trim());
      index += 1;
    }
    cueLines.push({ time: cueTimestampToSeconds(match[0].split("-->")[0].trim()), text: textLines.join(" ") });
  }
  return cueLines.length > 0
    ? { timed: true, lines: cueLines.sort((left, right) => left.time - right.time) }
    : { timed: false, lines: [] };
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

/**
 * Reads the Dialogue lines of an ASS or SSA subtitle as timed lines. Override
 * tags such as `{\an8}` are dropped, and `\N` line breaks become spaces.
 */
function parseAssDialogue(sourceLines: string[]): TimedLyricLine[] {
  let fields = defaultAssEventFields;
  const lines: TimedLyricLine[] = [];
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
    const text = values
      .slice(fields.length - 1)
      .join(",")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\[Nn]/g, " ")
      .replace(/\\h/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const time = assTimestampToSeconds(values[fields.indexOf("start")]?.trim() ?? "");
    if (time === null || !text) continue;
    lines.push({ time, text });
  }
  return lines;
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
 * all read the moved times.
 */
export function offsetTimedLyrics(parsed: ParsedLyrics, offsetMs: number): ParsedLyrics {
  if (!parsed.timed || !offsetMs) return parsed;
  const offsetSeconds = offsetMs / 1000;
  return {
    timed: true,
    lines: parsed.lines.map((line) => ({ ...line, time: Math.max(0, line.time + offsetSeconds) })),
  };
}

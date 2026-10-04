// Text viewer model: the player's timed-lyrics parsing plus what a reading view adds.

import { parseTimedLyrics } from "@/lib/timedLyrics";

export type LyricsLine = { timeSeconds: number; text: string };
export type LyricsTag = { key: string; value: string };
export type ParsedLyrics = { tags: LyricsTag[]; lines: LyricsLine[] };

const lrcStampPattern = /^\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/;
const lrcTagPattern = /^\[([A-Za-z]+):(.*)\]$/;
// Header tags worth showing; offset, length, and tool tags only describe the file.
const displayedTagKeys = new Set(["ti", "ar", "al", "au", "by"]);
// Mostly stamped lines make an LRC file; a script with a few stray stamps stays plain text.
const minimumStampedShare = 0.6;
// Cue voice and style spans and enhanced-LRC word stamps.
const inlineMarkupPattern = /<[^>]*>/g;

/**
 * Reads timed lyrics and subtitles (LRC, WebVTT, SRT) into the lines the player
 * shows, or returns null for ordinary text.
 */
export function parseLyrics(content: string): ParsedLyrics | null {
  const timed = parseTimedLyrics(content);
  if (!timed.timed) return null;
  const tags: LyricsTag[] = [];
  let textLines = 0;
  let stampedLines = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tag = lrcTagPattern.exec(line);
    if (tag) {
      const key = tag[1].toLowerCase();
      const value = tag[2].trim();
      if (displayedTagKeys.has(key) && value) tags.push({ key, value });
      continue;
    }
    textLines += 1;
    if (lrcStampPattern.test(line)) stampedLines += 1;
  }
  // Cue files carry their timing in structure, so only LRC needs the share check.
  if (stampedLines > 0 && stampedLines < textLines * minimumStampedShare) return null;
  return {
    tags,
    lines: timed.lines.map((line) => ({
      timeSeconds: line.time,
      text: line.text.replace(inlineMarkupPattern, "").replace(/\s+/g, " ").trim(),
    })),
  };
}

export function formatLyricsTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

export function countTextLines(content: string) {
  if (!content) return 0;
  return content.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

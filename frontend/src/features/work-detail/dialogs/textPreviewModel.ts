// Text viewer model: how a reading view shows the timed lyrics the server read.

import type { TimedLyricsResult } from "@/lib/api";

export type LyricsLine = { timeSeconds: number; text: string };
export type LyricsTag = { key: string; value: string };
export type ParsedLyrics = { tags: LyricsTag[]; lines: LyricsLine[] };

/**
 * The lines and song tags the viewer shows for a file the server read, or null
 * for ordinary text: a file with no timed line, or a script that only quotes a
 * few time marks.
 */
export function lyricsView(result: TimedLyricsResult | null): ParsedLyrics | null {
  if (!result?.timed || result.sparse) return null;
  return {
    tags: result.tags,
    lines: result.lines.map((line) => ({ timeSeconds: line.time, text: line.text })),
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

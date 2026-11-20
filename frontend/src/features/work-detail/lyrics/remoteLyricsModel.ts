/** Text formats the server accepts as downloadable lyrics. */
const remoteLyricsExtensions = [".lrc", ".vtt", ".srt", ".ass", ".ssa", ".txt"];

/** Whether the server accepts the file at this path as lyrics. */
export function isLyricsFilePath(path: string) {
  const lower = path.toLowerCase();
  return remoteLyricsExtensions.some((extension) => lower.endsWith(extension));
}

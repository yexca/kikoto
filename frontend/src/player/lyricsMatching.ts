import type { MediaItem } from "@/lib/api";

const lyricExtensions = [".lrc", ".vtt", ".srt", ".ass", ".txt", ".cue"];
const audioExtensions = [".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac"];
const sharedLyricNames = new Set(["lyrics", "lyric", "subtitle", "subtitles", "字幕", "翻译", "翻譯"]);

export type LyricsMatch = {
  locationId: number;
  title: string;
  path: string;
  reason: "exact_sidecar" | "same_stem" | "normalized_name" | "shared_folder";
};

export function findLyricsMatch(audioPath: string, items: MediaItem[]): LyricsMatch | null {
  return findLyricsMatches(audioPath, items)[0] ?? null;
}

export function findLyricsMatches(audioPath: string, items: MediaItem[]): LyricsMatch[] {
  const audioName = fileName(audioPath);
  const audioDirectory = directoryName(audioPath);
  const audioStem = stripLastExtension(audioName);
  const normalizedAudioStem = normalizeMediaName(audioStem);
  const candidates = items.flatMap((item) => item.locations
    .filter((location) => location.locationType === "local" && location.availability === "available" && isLyricsPath(location.path))
    .map((location) => scoreCandidate(location.id, location.path, audioName, audioStem, normalizedAudioStem, audioDirectory)))
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }));
  return candidates.map((candidate) => ({ locationId: candidate.locationId, title: fileName(candidate.path), path: candidate.path, reason: candidate.reason }));
}

export function isLyricsPath(path: string) {
  const lower = path.toLowerCase();
  return lyricExtensions.some((extension) => lower.endsWith(extension));
}

function scoreCandidate(locationId: number, path: string, audioName: string, audioStem: string, normalizedAudioStem: string, audioDirectory: string) {
  const lyricName = fileName(path);
  const lyricDirectory = directoryName(path);
  const lyricBase = stripKnownExtension(lyricName, lyricExtensions);
  const lyricStem = stripKnownExtension(lyricBase, audioExtensions);
  const sameDirectory = lyricDirectory.toLowerCase() === audioDirectory.toLowerCase();
  let score = sameDirectory ? 1000 : 0;
  let reason: LyricsMatch["reason"] | null = null;

  if (sameDirectory && lyricBase.toLowerCase() === audioName.toLowerCase()) {
    score += 10000;
    reason = "exact_sidecar";
  } else if (lyricStem.toLowerCase() === audioStem.toLowerCase()) {
    score += 7000;
    reason = "same_stem";
  } else if (normalizeMediaName(lyricStem) === normalizedAudioStem && normalizedAudioStem.length >= 2) {
    score += 4000;
    reason = "normalized_name";
  } else if (sameDirectory && sharedLyricNames.has(normalizeMediaName(lyricStem))) {
    score += 500;
    reason = "shared_folder";
  }
  if (!reason) return null;
  score += lyricFormatPreference(lyricName);
  return { locationId, path, reason, score };
}

function lyricFormatPreference(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".lrc")) return 6;
  if (lower.endsWith(".vtt")) return 5;
  if (lower.endsWith(".srt")) return 4;
  if (lower.endsWith(".ass")) return 3;
  if (lower.endsWith(".txt")) return 2;
  return 1;
}

function normalizeMediaName(value: string) {
  return value
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/^(track|tr|disc|cd)[\s_.-]*/i, "")
    .replace(/^[0-9]+[\s_.-]*/, "")
    .replace(/[\s_.\-()[\]【】「」『』]+/g, "");
}

function stripKnownExtension(value: string, extensions: string[]) {
  const lower = value.toLowerCase();
  const extension = extensions.find((candidate) => lower.endsWith(candidate));
  return extension ? value.slice(0, -extension.length) : value;
}

function stripLastExtension(value: string) {
  const index = value.lastIndexOf(".");
  return index > 0 ? value.slice(0, index) : value;
}

function fileName(path: string) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function directoryName(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

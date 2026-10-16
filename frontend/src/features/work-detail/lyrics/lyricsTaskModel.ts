import type { MediaItem, WorkDetail } from "@/lib/api";
import { allLyricsLanguages, editionLyricsLanguage, lyricsLanguages } from "@/lib/lyricsLanguage";
import type { LyricsManagerAudio, LyricsManagerFile } from "@/features/work-detail/lyrics/lyricsManagerModel";
import { isLyricsPath } from "@/player/lyricsMatching";

/**
 * The lyrics language of the work family's original edition, or the fallback
 * when it is unknown or not a lyrics language.
 */
export function workOriginLyricsLanguage(work: Pick<WorkDetail, "translations">): string {
  const origin = (work.translations ?? []).find((edition) => edition.origin);
  return origin ? editionLyricsLanguage(origin.metadataLanguage) : allLyricsLanguages;
}

/**
 * The lyrics file a track has in each language: its stored assignments, and
 * for the fallback also the file-name match that applies without one. Only
 * files `available` accepts count.
 */
export function trackLyricsByLanguage(
  entry: LyricsManagerAudio,
  available: (lyricsMediaItemId: number) => boolean = () => true,
): Map<string, number> {
  const lyrics = new Map<string, number>();
  for (const [language] of lyricsLanguages) {
    const assigned = entry.assignedLyrics[language];
    if (assigned !== undefined && available(assigned)) lyrics.set(language, assigned);
  }
  const matched = entry.autoLyricsMediaItemId;
  if (!lyrics.has(allLyricsLanguages) && matched !== null && available(matched)) {
    lyrics.set(allLyricsLanguages, matched);
  }
  return lyrics;
}

/** A lyrics file a translation can read: a local file, or a remote one the server reads when allowed. */
export type TranslationSourceFile = { locationId: number; title: string; remote: boolean; sourceName: string };

/** The readable location of each lyrics media item: its local file, otherwise its remote file. */
export function translationSourceFiles(
  items: readonly MediaItem[],
  local: readonly LyricsManagerFile[],
): Map<number, TranslationSourceFile> {
  const files = new Map<number, TranslationSourceFile>(
    local.map((file) => [
      file.mediaItemId,
      { locationId: file.locationId, title: file.title, remote: false, sourceName: "" },
    ]),
  );
  for (const item of items) {
    if (files.has(item.id) || item.kind === "audio" || item.kind === "video") continue;
    const location = item.locations.find(
      (candidate) => candidate.locationType === "remote_stream" && isLyricsPath(candidate.path),
    );
    if (location) {
      files.set(item.id, {
        locationId: location.id,
        title: item.title,
        remote: true,
        sourceName: location.fileSourceName,
      });
    }
  }
  return files;
}

/** Which tracks the Transcribe list shows. */
export type TranscribeFilter = "noLyrics" | "noOrigin" | "all";

export function matchesTranscribeFilter(lyrics: ReadonlyMap<string, number>, filter: TranscribeFilter, origin: string) {
  if (filter === "noLyrics") return lyrics.size === 0;
  if (filter === "noOrigin") return !lyrics.has(origin);
  return true;
}

/** What one track translates: the language it reads, and the languages it creates. */
export type TranslationRow = { source: string; targets: ReadonlySet<string> };

/** The chosen translations per audio media item. A track without targets has no row. */
export type TranslationSelection = ReadonlyMap<number, TranslationRow>;

/** The languages lyrics are translated into: every declared language except the fallback. */
export const translationTargetLanguages = lyricsLanguages
  .map(([language]) => language)
  .filter((language) => language !== allLyricsLanguages);

/**
 * The language a track translates from unless another is chosen: the original
 * language, then the fallback, then the first language it has lyrics in.
 */
export function defaultTranslationSource(lyrics: ReadonlyMap<string, number>, origin: string): string | null {
  if (lyrics.has(origin)) return origin;
  if (lyrics.has(allLyricsLanguages)) return allLyricsLanguages;
  return lyricsLanguages.find(([language]) => lyrics.has(language))?.[0] ?? null;
}

/** Adds or removes one target of a track. A track without lyrics to read cannot gain one. */
export function toggleTranslationTarget(
  selection: TranslationSelection,
  audioId: number,
  lyrics: ReadonlyMap<string, number>,
  language: string,
  origin: string,
): TranslationSelection {
  const row = selection.get(audioId);
  const targets = new Set(row?.targets);
  if (targets.has(language)) targets.delete(language);
  else targets.add(language);
  return withRow(selection, audioId, row?.source ?? defaultTranslationSource(lyrics, origin), targets);
}

/** Reads a track's translations from another of its languages. */
export function chooseTranslationSource(
  selection: TranslationSelection,
  audioId: number,
  language: string,
): TranslationSelection {
  const row = selection.get(audioId);
  if (!row) return selection;
  return new Map(selection).set(audioId, { ...row, source: language });
}

/**
 * Selects a language for every listed track that can gain it, or clears it
 * from all of them when each already has it.
 */
export function toggleTranslationColumn(
  selection: TranslationSelection,
  tracks: readonly { audioId: number; lyrics: ReadonlyMap<string, number> }[],
  language: string,
  origin: string,
): TranslationSelection {
  const open = tracks.filter(
    ({ lyrics }) => !lyrics.has(language) && defaultTranslationSource(lyrics, origin) !== null,
  );
  const selected = open.every(({ audioId }) => selection.get(audioId)?.targets.has(language));
  let next = selection;
  for (const { audioId, lyrics } of open) {
    const row = next.get(audioId);
    const targets = new Set(row?.targets);
    if (selected) targets.delete(language);
    else targets.add(language);
    next = withRow(next, audioId, row?.source ?? defaultTranslationSource(lyrics, origin), targets);
  }
  return next;
}

/** One translation to queue. */
export type TranslationJob = { audioMediaItemId: number; lyricsMediaItemId: number; targetLanguage: string };

/** The translations a selection queues, in track order and then language order. */
export function translationJobs(
  selection: TranslationSelection,
  tracks: readonly { audioId: number; lyrics: ReadonlyMap<string, number> }[],
): TranslationJob[] {
  return tracks.flatMap(({ audioId, lyrics }) => {
    const row = selection.get(audioId);
    const source = row ? lyrics.get(row.source) : undefined;
    if (!row || source === undefined) return [];
    return translationTargetLanguages
      .filter((language) => row.targets.has(language) && !lyrics.has(language))
      .map((targetLanguage) => ({ audioMediaItemId: audioId, lyricsMediaItemId: source, targetLanguage }));
  });
}

function withRow(
  selection: TranslationSelection,
  audioId: number,
  source: string | null,
  targets: ReadonlySet<string>,
): TranslationSelection {
  const next = new Map(selection);
  if (source === null || targets.size === 0) next.delete(audioId);
  else next.set(audioId, { source, targets });
  return next;
}

/**
 * Sends a request that holds one of the server's few LLM request slots. While
 * every slot is taken the server refuses it as busy, so it waits, doubling the
 * wait each time, and tries again up to `retries` times.
 */
export async function whenLLMFree<T>(
  request: () => Promise<T>,
  { retries = 5, delayMs = 500, sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "llm_busy" || attempt >= retries) throw error;
      await sleep(delayMs * 2 ** attempt);
    }
  }
}

import type { ASRService } from "@/lib/asrApi";
import type {
  TranslationCategory,
  TranslationItemState,
  TranslationLyricsTarget,
  TranslationPlan,
  TranslationPlanLanguage,
} from "@/lib/translationApi";
import { allLyricsLanguages } from "@/lib/lyricsLanguage";
import {
  defaultTranslationSource,
  type TranslationSelection,
  type TranslationSourceFile,
} from "@/features/work-detail/lyrics/lyricsTaskModel";

/** A track as the dialog plans it: its lyrics file per language. */
export type PlanTrack = { audioId: number; lyrics: ReadonlyMap<string, number> };

/** The key of one track's lyrics in one language. */
export function lyricsCellKey(audioId: number, language: string) {
  return `${audioId}:${language}`;
}

/** Track and language pairs an item is translating or waiting with, by state. */
export function activeLyricsCells(plan: TranslationPlan | null): Map<string, TranslationItemState> {
  const cells = new Map<string, TranslationItemState>();
  for (const language of plan?.languages ?? []) {
    for (const track of language.lyrics)
      cells.set(lyricsCellKey(track.audioMediaItemId, language.language), track.state);
  }
  return cells;
}

/** What the lyrics of a request translate and transcribe. */
export type LyricsPlan = {
  /** Tracks with lyrics: the language each reads and the languages it creates. */
  selection: TranslationSelection;
  /** Tracks without any lyrics that are transcribed first. */
  transcribe: ReadonlySet<number>;
};

/**
 * Every missing lyrics cell of the chosen languages: a track with lyrics
 * translates from its default source; a track without any is transcribed
 * first when transcription is on. Cells already being translated or waiting
 * for review are left out.
 */
export function defaultLyricsPlan({
  tracks,
  languages,
  origin,
  active,
  transcribe,
  transcribing,
}: {
  tracks: readonly PlanTrack[];
  languages: readonly string[];
  origin: string;
  active: ReadonlyMap<string, TranslationItemState>;
  transcribe: boolean;
  /** Tracks with a transcription that is already running. */
  transcribing: ReadonlySet<number>;
}): LyricsPlan {
  const selection = new Map<number, { source: string; targets: ReadonlySet<string> }>();
  const transcribed = new Set<number>();
  for (const track of tracks) {
    const missing = languages.filter(
      (language) => !track.lyrics.has(language) && !active.has(lyricsCellKey(track.audioId, language)),
    );
    if (missing.length === 0) continue;
    if (track.lyrics.size === 0) {
      if (transcribe && !transcribing.has(track.audioId)) transcribed.add(track.audioId);
      continue;
    }
    const source = defaultTranslationSource(track.lyrics, origin);
    if (source !== null) selection.set(track.audioId, { source, targets: new Set(missing) });
  }
  return { selection, transcribe: transcribed };
}

/** The lyrics entries of a request, in track order and then language order. */
export function lyricsRequestTargets({
  tracks,
  languages,
  plan,
  sourceFiles,
  active,
}: {
  tracks: readonly PlanTrack[];
  languages: readonly string[];
  plan: LyricsPlan;
  sourceFiles: ReadonlyMap<number, TranslationSourceFile>;
  active: ReadonlyMap<string, TranslationItemState>;
}): TranslationLyricsTarget[] {
  const targets: TranslationLyricsTarget[] = [];
  for (const track of tracks) {
    const open = (language: string) =>
      language !== allLyricsLanguages &&
      !track.lyrics.has(language) &&
      !active.has(lyricsCellKey(track.audioId, language));
    if (plan.transcribe.has(track.audioId)) {
      for (const language of languages) {
        if (open(language))
          targets.push({ audioMediaItemId: track.audioId, targetLanguage: language, lyricsLocationId: 0 });
      }
      continue;
    }
    const row = plan.selection.get(track.audioId);
    const source = row ? track.lyrics.get(row.source) : undefined;
    const file = source === undefined ? undefined : sourceFiles.get(source);
    if (!row || !file) continue;
    for (const language of languages) {
      if (row.targets.has(language) && open(language)) {
        targets.push({ audioMediaItemId: track.audioId, targetLanguage: language, lyricsLocationId: file.locationId });
      }
    }
  }
  return targets;
}

const planCategoryKeys = { title: "title", description: "description", tags: "tags", files: "files" } as const;

/** Missing objects of one category in one language. */
export function missingCount(language: TranslationPlanLanguage, category: TranslationCategory) {
  return language[planCategoryKeys[category]].missing;
}

/** What a request sends per language: characters of text, and tracks of lyrics. */
export type LanguageEstimate = { language: string; items: number; characters: number; lyricsTracks: number };

export function requestEstimates(
  plan: TranslationPlan | null,
  categories: readonly TranslationCategory[],
  lyrics: readonly TranslationLyricsTarget[],
): LanguageEstimate[] {
  return (plan?.languages ?? []).map((language) => {
    const lyricsTracks = lyrics.filter((entry) => entry.targetLanguage === language.language).length;
    let items = lyricsTracks;
    let characters = 0;
    for (const category of categories) {
      const entry = language[planCategoryKeys[category]];
      items += entry.missing;
      characters += entry.characters;
    }
    return { language: language.language, items, characters, lyricsTracks };
  });
}

/**
 * Whether a speech model writes the one target language directly from the
 * original speech. Direct output applies only when every transcribed track is
 * translated into that one language, since each track is transcribed once.
 */
export function directASRLanguage(
  service: Pick<ASRService, "translations"> | null | undefined,
  model: string | undefined,
  origin: string,
  transcribedLanguages: readonly string[],
): string | null {
  if (!service || !model || transcribedLanguages.length !== 1) return null;
  const translation = service.translations?.[model];
  const [language] = transcribedLanguages;
  if (!translation || translation.source !== origin || translation.target !== language || language === origin)
    return null;
  return language;
}

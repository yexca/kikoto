import type {
  TranslationCategory,
  TranslationItem,
  TranslationItemState,
  TranslationLyricsTarget,
  TranslationPlan,
  TranslationPlanLanguage,
} from "@/lib/translationApi";
import { allLyricsLanguages, lyricsLanguages } from "@/lib/lyricsLanguage";
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

/**
 * What the lyrics of a request translate: per track with lyrics, the language
 * it reads and the languages it creates. A track without lyrics has none.
 */
export type LyricsPlan = { selection: TranslationSelection };

/**
 * Whether the chosen model translates lyrics declared in `source` into
 * `target`; the fallback's unknown language is the empty source.
 */
export type LyricsDirection = (source: string, target: string) => boolean;

/** A model that declares no directions translates any of them. */
export const anyLyricsDirection: LyricsDirection = () => true;

/**
 * The language the lyrics file a track reads in `source` is declared in, as
 * the server reads it: the last of the languages the track has that file in,
 * or unknown when it is only the fallback.
 */
export function lyricsFileLanguage(track: PlanTrack, source: string): string {
  const file = track.lyrics.get(source);
  let language = allLyricsLanguages;
  for (const [candidate, id] of track.lyrics) if (id === file && candidate > language) language = candidate;
  return language;
}

/** Whether the lyrics a track has in `source` can become `target` with the chosen model. */
export function translatesLyrics(track: PlanTrack, source: string, target: string, translates: LyricsDirection) {
  return track.lyrics.has(source) && translates(lyricsFileLanguage(track, source), target);
}

/**
 * The language a track reads when it gains one of `languages`: its default
 * source while the model translates that into one of them, otherwise the
 * first of its other lyrics that it does, otherwise the default source.
 */
export function preferredLyricsSource(
  track: PlanTrack,
  origin: string,
  languages: readonly string[],
  translates: LyricsDirection,
): string | null {
  const fallback = defaultTranslationSource(track.lyrics, origin);
  const candidates = [fallback, ...lyricsLanguages.map(([language]) => language)];
  const reads = (source: string | null): source is string =>
    source !== null && languages.some((language) => translatesLyrics(track, source, language, translates));
  return candidates.find(reads) ?? fallback;
}

/** Whether a track lacks lyrics in a language it could create from one of its lyrics files. */
export function canTranslateLyrics(
  track: PlanTrack,
  language: string,
  active: ReadonlyMap<string, TranslationItemState>,
) {
  return (
    track.lyrics.size > 0 &&
    language !== allLyricsLanguages &&
    !track.lyrics.has(language) &&
    !active.has(lyricsCellKey(track.audioId, language))
  );
}

/** What decides which lyrics cells a request can choose. */
export type LyricsCellContext = {
  plan: LyricsPlan;
  origin: string;
  active: ReadonlyMap<string, TranslationItemState>;
  translates: LyricsDirection;
};

/**
 * Whether a track can gain a language in this request: it lacks it, and the
 * model translates into it from the lyrics the track reads, or would read
 * once the language is chosen.
 */
export function lyricsCellOpen(track: PlanTrack, language: string, context: LyricsCellContext) {
  if (!canTranslateLyrics(track, language, context.active)) return false;
  const source =
    context.plan.selection.get(track.audioId)?.source ??
    preferredLyricsSource(track, context.origin, [language], context.translates);
  return source !== null && translatesLyrics(track, source, language, context.translates);
}

/**
 * Every missing lyrics cell of the chosen languages that a track can
 * translate, each track reading lyrics the model translates. Cells already
 * being translated or waiting for review are left out.
 */
export function defaultLyricsPlan({
  tracks,
  languages,
  origin,
  active,
  translates = anyLyricsDirection,
}: {
  tracks: readonly PlanTrack[];
  languages: readonly string[];
  origin: string;
  active: ReadonlyMap<string, TranslationItemState>;
  translates?: LyricsDirection;
}): LyricsPlan {
  const selection = new Map<number, { source: string; targets: ReadonlySet<string> }>();
  for (const track of tracks) {
    const missing = languages.filter((language) => canTranslateLyrics(track, language, active));
    const source = preferredLyricsSource(track, origin, missing, translates);
    if (source === null) continue;
    const targets = missing.filter((language) => translatesLyrics(track, source, language, translates));
    if (targets.length > 0) selection.set(track.audioId, { source, targets: new Set(targets) });
  }
  return { selection };
}

/** Chooses or clears `languages` of one track, keeping the lyrics it reads or choosing them. */
function withTargets(
  track: PlanTrack,
  languages: readonly string[],
  chosen: boolean,
  context: LyricsCellContext,
): LyricsPlan {
  const row = context.plan.selection.get(track.audioId);
  const targets = new Set(row?.targets);
  for (const language of languages) {
    if (chosen) targets.add(language);
    else targets.delete(language);
  }
  const source = row?.source ?? preferredLyricsSource(track, context.origin, languages, context.translates);
  const selection = new Map(context.plan.selection);
  if (source === null || targets.size === 0) selection.delete(track.audioId);
  else selection.set(track.audioId, { source, targets });
  return { selection };
}

/** Adds or removes one language of one track. */
export function toggleLyricsCell(track: PlanTrack, language: string, context: LyricsCellContext): LyricsPlan {
  const chosen = context.plan.selection.get(track.audioId)?.targets.has(language) ?? false;
  return withTargets(track, [language], !chosen, context);
}

/** Reads one track's translations from another of its lyrics. */
export function chooseLyricsSource(plan: LyricsPlan, track: PlanTrack, source: string): LyricsPlan {
  const row = plan.selection.get(track.audioId);
  if (!row) return plan;
  return { selection: new Map(plan.selection).set(track.audioId, { ...row, source }) };
}

/** Whether every open cell is chosen, some are, or none; null when no cell is open. */
export type LyricsChoice = "all" | "some" | "none" | null;

function choiceOf(cells: readonly boolean[]): LyricsChoice {
  if (cells.length === 0) return null;
  const chosen = cells.filter(Boolean).length;
  return chosen === cells.length ? "all" : chosen > 0 ? "some" : "none";
}

/** How much of one language the tracks that can create it have chosen. */
export function lyricsLanguageChoice(
  tracks: readonly PlanTrack[],
  language: string,
  context: LyricsCellContext,
): LyricsChoice {
  return choiceOf(
    tracks
      .filter((track) => lyricsCellOpen(track, language, context))
      .map((track) => context.plan.selection.get(track.audioId)?.targets.has(language) ?? false),
  );
}

/**
 * Chooses a language for every track that can create it, or clears it from
 * all of them when each already has it chosen.
 */
export function toggleLyricsLanguage(
  tracks: readonly PlanTrack[],
  language: string,
  context: LyricsCellContext,
): LyricsPlan {
  const chosen = lyricsLanguageChoice(tracks, language, context) === "all";
  return tracks
    .filter((track) => lyricsCellOpen(track, language, context))
    .reduce((plan, track) => withTargets(track, [language], !chosen, { ...context, plan }), context.plan);
}

/** How much of the languages one track can create is chosen. */
export function lyricsTrackChoice(
  track: PlanTrack,
  languages: readonly string[],
  context: LyricsCellContext,
): LyricsChoice {
  const row = context.plan.selection.get(track.audioId);
  return choiceOf(
    languages
      .filter((language) => lyricsCellOpen(track, language, context))
      .map((language) => row?.targets.has(language) ?? false),
  );
}

/**
 * Chooses every one of `languages` that one track can create, or clears them
 * all when each is already chosen.
 */
export function toggleLyricsTrack(
  track: PlanTrack,
  languages: readonly string[],
  context: LyricsCellContext,
): LyricsPlan {
  const open = languages.filter((language) => lyricsCellOpen(track, language, context));
  if (open.length === 0) return context.plan;
  return withTargets(track, open, lyricsTrackChoice(track, languages, context) !== "all", context);
}

/**
 * The lyrics entries of a request, in track order and then language order.
 * A chosen language the model cannot create from the lyrics a track reads is
 * left out.
 */
export function lyricsRequestTargets({
  tracks,
  languages,
  plan,
  sourceFiles,
  active,
  translates = anyLyricsDirection,
}: {
  tracks: readonly PlanTrack[];
  languages: readonly string[];
  plan: LyricsPlan;
  sourceFiles: ReadonlyMap<number, TranslationSourceFile>;
  active: ReadonlyMap<string, TranslationItemState>;
  translates?: LyricsDirection;
}): TranslationLyricsTarget[] {
  const targets: TranslationLyricsTarget[] = [];
  for (const track of tracks) {
    const row = plan.selection.get(track.audioId);
    const source = row ? track.lyrics.get(row.source) : undefined;
    const file = source === undefined ? undefined : sourceFiles.get(source);
    if (!row || !file) continue;
    for (const language of languages) {
      if (
        row.targets.has(language) &&
        canTranslateLyrics(track, language, active) &&
        translatesLyrics(track, row.source, language, translates)
      ) {
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

/**
 * What a request sends per language. The work's text goes only into the
 * languages `translatesText` accepts, which the model translates into from
 * the work's original language.
 */
export function requestEstimates(
  plan: TranslationPlan | null,
  categories: readonly TranslationCategory[],
  lyrics: readonly TranslationLyricsTarget[],
  translatesText: (language: string) => boolean = () => true,
): LanguageEstimate[] {
  return (plan?.languages ?? []).map((language) => {
    const lyricsTracks = lyrics.filter((entry) => entry.targetLanguage === language.language).length;
    let items = lyricsTracks;
    let characters = 0;
    for (const category of translatesText(language.language) ? categories : []) {
      const entry = language[planCategoryKeys[category]];
      items += entry.missing;
      characters += entry.characters;
    }
    return { language: language.language, items, characters, lyricsTracks };
  });
}

/** Where the results list an item: waiting for review, in progress, stopped, or applied. */
export type ResultsSection = "review" | "active" | "attention" | "history";

export const resultsSections: readonly ResultsSection[] = ["review", "active", "attention", "history"];

const resultsSectionByState: Partial<Record<TranslationItemState, ResultsSection>> = {
  ready: "review",
  queued: "active",
  requesting: "active",
  failed: "attention",
  uncertain: "attention",
  invalid: "attention",
  policy_blocked: "attention",
  accepted: "history",
};

/** The results section of an item's state; discarded and cancelled items are not listed. */
export function resultsSection(state: TranslationItemState): ResultsSection | null {
  return resultsSectionByState[state] ?? null;
}

/**
 * How far the runs that are still working have got: their items that have
 * finished, applied or stopped, out of all their items. Null while nothing runs.
 */
export function runningProgress(
  items: readonly Pick<TranslationItem, "runId" | "state">[],
): { done: number; total: number } | null {
  const running = new Set(items.filter((item) => resultsSection(item.state) === "active").map((item) => item.runId));
  if (running.size === 0) return null;
  const runItems = items.filter((item) => running.has(item.runId));
  return {
    done: runItems.filter((item) => resultsSection(item.state) !== "active").length,
    total: runItems.length,
  };
}

import type { LyricsManagerAudio } from "@/features/work-detail/lyrics/lyricsManagerModel";
import type { TranslationSourceFile } from "@/features/work-detail/lyrics/lyricsTaskModel";
import type {
  ASRService,
  ASRTranscription,
  ASRTranscriptionState,
  LLMLyricsTranslation,
  LLMLyricsTranslationState,
  LLMTranslationModel,
} from "@/lib/api";
import { allLyricsLanguages, lyricsLanguages } from "@/lib/lyricsLanguage";

// Demo contacts no transcription or translation service and saves nothing.
// These samples show the Transcribe and Translate tabs in each of their
// states over the work's own tracks. Every name is an obvious example.

export const demoASRServices: ASRService[] = [
  {
    id: "demo-asr",
    name: "Example speech service",
    defaultModel: "example-small",
    models: ["example-small", "example-large"],
    boundary: "private",
    maxContentClass: "sensitive",
  },
];

export const demoTranslationModels: LLMTranslationModel[] = [
  {
    id: "demo-llm",
    name: "Example LLM provider",
    defaultModel: "example-model",
    models: ["example-model"],
    boundary: "private",
    maxContentClass: "sensitive",
  },
];

const demoTranscriptionStates: { state: ASRTranscriptionState; progress?: number; failureCode?: string }[] = [
  { state: "ready" },
  { state: "requesting", progress: 0.4 },
  { state: "pending" },
  { state: "failed", failureCode: "no_speech" },
];

/** One sample transcription in each state, over the work's first tracks. */
export function demoTranscriptions(audio: readonly LyricsManagerAudio[], language: string): ASRTranscription[] {
  const service = demoASRServices[0];
  return audio.slice(0, demoTranscriptionStates.length).map((entry, index) => {
    const { state, progress = 0, failureCode } = demoTranscriptionStates[index];
    const durationMs = Math.round((entry.durationSeconds ?? 0) * 1000);
    return {
      id: `demo-${entry.mediaItemId}`,
      runId: 0,
      audioMediaItemId: entry.mediaItemId,
      audioTitle: entry.title,
      language,
      providerName: service.name,
      model: service.defaultModel,
      state,
      ...(failureCode ? { failureCode } : {}),
      progressMs: Math.round(durationMs * progress),
      durationMs,
      createdAt: "",
    };
  });
}

const demoTranslationStates: { state: LLMLyricsTranslationState; failureCode?: string }[] = [
  { state: "ready" },
  { state: "requesting" },
  { state: "failed", failureCode: "endpoint_unavailable" },
];

/** A track the matrix shows: its readable lyrics file per language. */
export type DemoTranslationTrack = { audioId: number; lyrics: ReadonlyMap<string, number> };

/**
 * One sample translation in each state, over the first tracks that have
 * lyrics, each into a language the track lacks other than the original.
 */
export function demoLyricsTranslations(
  tracks: readonly DemoTranslationTrack[],
  sourceFiles: ReadonlyMap<number, TranslationSourceFile>,
  origin: string,
): LLMLyricsTranslation[] {
  const provider = demoTranslationModels[0];
  const result: LLMLyricsTranslation[] = [];
  for (const track of tracks) {
    if (result.length === demoTranslationStates.length) break;
    const sourceID = track.lyrics.get(origin) ?? track.lyrics.values().next().value;
    const file = sourceID === undefined ? undefined : sourceFiles.get(sourceID);
    const targets = lyricsLanguages
      .map(([language]) => language)
      .filter((language) => language !== allLyricsLanguages && language !== origin && !track.lyrics.has(language));
    if (!file || targets.length === 0) continue;
    const { state, failureCode } = demoTranslationStates[result.length];
    result.push({
      taskId: result.length + 1,
      runId: 0,
      audioMediaItemId: track.audioId,
      lyricsLocationId: file.locationId,
      // Successive samples go to successive languages where the track lacks several.
      targetLanguage: targets[result.length % targets.length],
      providerName: provider.name,
      model: provider.models[0],
      state,
      ...(failureCode ? { failureCode } : {}),
      ...(state === "ready" ? { previewId: `demo-${track.audioId}` } : {}),
      updatedAt: "",
    });
  }
  return result;
}

const demoCueCount = 6;
const demoCueSeconds = 5;

/** Sample WebVTT a Demo preview shows: a few spaced cues within the track's duration. */
export function demoLyricsText(durationSeconds: number | null, cue: (number: number) => string) {
  const span = durationSeconds && durationSeconds > 0 ? durationSeconds : demoCueCount * demoCueSeconds * 2;
  const step = span / demoCueCount;
  const cues = Array.from({ length: demoCueCount }, (_, index) => {
    const start = index * step;
    const end = Math.min(span, start + Math.min(demoCueSeconds, step));
    return `${vttTime(start)} --> ${vttTime(end)}\n${cue(index + 1)}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

function vttTime(seconds: number) {
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(ms, 3)}`;
}

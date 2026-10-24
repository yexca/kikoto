import type { LyricsManagerAudio } from "@/features/work-detail/lyrics/lyricsManagerModel";
import type { ASRService, ASRTranscription, ASRTranscriptionState } from "@/lib/api";

// Demo contacts no transcription or translation service and saves nothing.
// These samples show the Transcribe tab in each of its states over the
// work's own tracks. Every name is an obvious example.

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
      audioLanguage: language,
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

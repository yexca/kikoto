import { describe, expect, it } from "vitest";

import type { WorkTranslation } from "@/lib/api";

import type { LyricsManagerAudio } from "./lyricsManagerModel";
import {
  chooseTranslationSource,
  matchesTranscribeFilter,
  toggleTranslationColumn,
  toggleTranslationTarget,
  trackLyricsByLanguage,
  modelCapability,
  offersTranscription,
  transcriptionOutput,
  translationJobs,
  workOriginLyricsLanguage,
  whenLLMFree,
  type TranslationSelection,
} from "./lyricsTaskModel";

function track(
  mediaItemId: number,
  assignedLyrics: Record<string, number> = {},
  autoLyricsMediaItemId: number | null = null,
): LyricsManagerAudio {
  return {
    mediaItemId,
    title: `${mediaItemId}.mp3`,
    path: `${mediaItemId}.mp3`,
    folder: "",
    durationSeconds: null,
    assignedLyrics,
    autoLyricsMediaItemId,
  };
}

function edition(metadataLanguage: string, origin: boolean): WorkTranslation {
  return {
    workId: null,
    primaryCode: "",
    title: "",
    metadataLanguage,
    editionLabel: "",
    origin,
    official: origin,
    translationKind: origin ? "origin" : "official",
    current: false,
    hasMedia: false,
    mediaState: "metadata_only",
    localAvailable: false,
  };
}

const none: TranslationSelection = new Map();

describe("workOriginLyricsLanguage", () => {
  it("uses the original edition's language, and the fallback when no edition is the original", () => {
    expect(workOriginLyricsLanguage({ translations: [edition("JPN", true), edition("CHI_HANS", false)] })).toBe(
      "ja-jp",
    );
    expect(workOriginLyricsLanguage({ translations: [edition("CHI_HANS", false)] })).toBe("");
    expect(workOriginLyricsLanguage({ translations: [] })).toBe("");
  });
});

describe("trackLyricsByLanguage", () => {
  it("counts the name match as fallback lyrics only without a fallback assignment", () => {
    expect(Object.fromEntries(trackLyricsByLanguage(track(1, { "ja-jp": 10 }, 11)))).toEqual({ "": 11, "ja-jp": 10 });
    expect(trackLyricsByLanguage(track(1, { "": 12 }, 11)).get("")).toBe(12);
  });

  it("leaves out files that cannot be read", () => {
    expect(trackLyricsByLanguage(track(1, { "ja-jp": 10 }, 11), (id) => id === 10).has("")).toBe(false);
  });
});

describe("matchesTranscribeFilter", () => {
  const japanese = new Map([["ja-jp", 10]]);
  const fallback = new Map([["", 11]]);

  it("finds tracks without lyrics, and tracks without lyrics in the original language", () => {
    expect(matchesTranscribeFilter(new Map(), "noLyrics", "ja-jp")).toBe(true);
    expect(matchesTranscribeFilter(fallback, "noLyrics", "ja-jp")).toBe(false);
    expect(matchesTranscribeFilter(fallback, "noOrigin", "ja-jp")).toBe(true);
    expect(matchesTranscribeFilter(japanese, "noOrigin", "ja-jp")).toBe(false);
    expect(matchesTranscribeFilter(japanese, "all", "ja-jp")).toBe(true);
  });
});

describe("transcription models", () => {
  const service = {
    capabilities: {
      "example-multilingual": { kind: "transcribe" as const, multilingual: true },
      "example-japanese": { kind: "transcribe" as const, languages: ["ja-jp"] },
      "example-translating": { kind: "translate" as const, translation: { source: "ja-jp", target: "zh-cn" } },
    },
  };
  const offered = (audio: string) =>
    ["example-multilingual", "example-japanese", "example-translating", "example-entered-by-hand"].filter((model) =>
      offersTranscription(modelCapability(service, model), audio),
    );

  it("offers the models that hear the audio language, and every model of unknown capability", () => {
    expect(modelCapability(service, "example-entered-by-hand")).toEqual({ kind: "unknown" });
    expect(offered("ja-jp")).toEqual([
      "example-multilingual",
      "example-japanese",
      "example-translating",
      "example-entered-by-hand",
    ]);
    expect(offered("en-us")).toEqual(["example-multilingual", "example-entered-by-hand"]);
    // Detected speech has no source language to translate from.
    expect(offered("")).toEqual(["example-multilingual", "example-japanese", "example-entered-by-hand"]);
  });

  it("lets the model fix the lyrics language, and a model of unknown capability write the chosen one", () => {
    const output = (model: string, audio: string, chosen: string | null = null) =>
      transcriptionOutput(modelCapability(service, model), audio, chosen);
    expect(output("example-japanese", "ja-jp", "zh-cn")).toEqual({ language: "ja-jp", fixed: true });
    expect(output("example-translating", "ja-jp", "en-us")).toEqual({ language: "zh-cn", fixed: true });
    expect(output("example-entered-by-hand", "ja-jp")).toEqual({ language: "ja-jp", fixed: false });
    expect(output("example-entered-by-hand", "ja-jp", "zh-cn")).toEqual({ language: "zh-cn", fixed: false });
    // Detected speech is saved as fallback lyrics.
    expect(output("example-entered-by-hand", "", "zh-cn")).toEqual({ language: "", fixed: true });
    expect(output("example-multilingual", "")).toEqual({ language: "", fixed: true });
  });
});

describe("translation selection", () => {
  const japanese = { audioId: 1, lyrics: new Map([["ja-jp", 10]]) };
  const fallbackOnly = { audioId: 2, lyrics: new Map([["", 20]]) };
  const translated = { audioId: 3, lyrics: new Map([["en-us", 30]]) };
  const silent = { audioId: 4, lyrics: new Map<string, number>() };
  const tracks = [japanese, fallbackOnly, translated, silent];

  it("translates from the original language, then the fallback, then any language", () => {
    let selection = toggleTranslationTarget(none, 1, japanese.lyrics, "zh-cn", "ja-jp");
    selection = toggleTranslationTarget(selection, 2, fallbackOnly.lyrics, "zh-cn", "ja-jp");
    selection = toggleTranslationTarget(selection, 3, translated.lyrics, "zh-cn", "ja-jp");
    expect(translationJobs(selection, tracks)).toEqual([
      { audioMediaItemId: 1, lyricsMediaItemId: 10, targetLanguage: "zh-cn" },
      { audioMediaItemId: 2, lyricsMediaItemId: 20, targetLanguage: "zh-cn" },
      { audioMediaItemId: 3, lyricsMediaItemId: 30, targetLanguage: "zh-cn" },
    ]);
  });

  it("drops a track whose last target is cleared, and never selects a track without lyrics", () => {
    const selected = toggleTranslationTarget(none, 1, japanese.lyrics, "zh-cn", "ja-jp");
    expect(toggleTranslationTarget(selected, 1, japanese.lyrics, "zh-cn", "ja-jp").size).toBe(0);
    expect(toggleTranslationTarget(none, 4, silent.lyrics, "zh-cn", "ja-jp").size).toBe(0);
  });

  it("reads a chosen source for every target of the track", () => {
    const lyrics = new Map([
      ["ja-jp", 10],
      ["en-us", 11],
    ]);
    let selection = toggleTranslationTarget(none, 1, lyrics, "zh-cn", "ja-jp");
    selection = toggleTranslationTarget(selection, 1, lyrics, "ko-kr", "ja-jp");
    selection = chooseTranslationSource(selection, 1, "en-us");
    expect(translationJobs(selection, [{ audioId: 1, lyrics }])).toEqual([
      { audioMediaItemId: 1, lyricsMediaItemId: 11, targetLanguage: "zh-cn" },
      { audioMediaItemId: 1, lyricsMediaItemId: 11, targetLanguage: "ko-kr" },
    ]);
  });

  it("selects a whole column, then clears it", () => {
    const column = [japanese, fallbackOnly, silent];
    const selected = toggleTranslationColumn(none, column, "zh-cn", "ja-jp");
    expect([...selected.keys()]).toEqual([1, 2]);
    expect(toggleTranslationColumn(selected, column, "zh-cn", "ja-jp").size).toBe(0);
  });
});

describe("whenLLMFree", () => {
  // The API refusal while every LLM request slot is taken.
  const busy = () => Object.assign(new Error("Translation service is busy."), { status: 429, code: "llm_busy" });

  it("waits and tries again while the server's LLM slots are taken", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await whenLLMFree(
      async () => {
        calls++;
        if (calls < 3) throw busy();
        return "rated";
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe("rated");
    expect(waits).toEqual([500, 1000]);
  });

  it("gives up after its retries, and never retries another failure", async () => {
    const sleep = async () => {};
    await expect(whenLLMFree(() => Promise.reject(busy()), { retries: 2, sleep })).rejects.toMatchObject({
      code: "llm_busy",
    });
    let calls = 0;
    const refused = Object.assign(new Error("Blocked."), { status: 403, code: "llm_policy_blocked" });
    await expect(
      whenLLMFree(
        () => {
          calls++;
          return Promise.reject(refused);
        },
        { sleep },
      ),
    ).rejects.toBe(refused);
    expect(calls).toBe(1);
  });
});

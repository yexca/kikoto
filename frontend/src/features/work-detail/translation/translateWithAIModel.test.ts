import { describe, expect, it } from "vitest";

import type { TranslationPlan } from "@/lib/translationApi";
import {
  activeLyricsCells,
  defaultLyricsPlan,
  directASRLanguage,
  lyricsRequestTargets,
  requestEstimates,
  type PlanTrack,
} from "./translateWithAIModel";

const tracks: PlanTrack[] = [
  // Japanese lyrics only.
  { audioId: 1, lyrics: new Map([["ja-jp", 11]]) },
  // Already has Simplified Chinese.
  {
    audioId: 2,
    lyrics: new Map([
      ["ja-jp", 12],
      ["zh-cn", 22],
    ]),
  },
  // No lyrics at all.
  { audioId: 3, lyrics: new Map() },
];
const sourceFiles = new Map([
  [11, { locationId: 111, title: "1.lrc", remote: false, sourceName: "" }],
  [12, { locationId: 112, title: "2.lrc", remote: false, sourceName: "" }],
  [22, { locationId: 122, title: "2.zh.lrc", remote: false, sourceName: "" }],
]);

function plan(languages: TranslationPlan["languages"]): TranslationPlan {
  return {
    workId: 1,
    originLanguage: "ja-jp",
    permissions: { metadata: true, files: true, lyrics: true },
    languages,
    transcribing: [],
    attributionEnabled: true,
    autoAccept: true,
  };
}

const empty = { missing: 0, active: 0, characters: 0 };

describe("Translate with AI lyrics planning", () => {
  it("translates only missing cells, from the original language, and transcribes tracks without lyrics", () => {
    const active = new Map([["1:en-us", "ready" as const]]);
    const lyricsPlan = defaultLyricsPlan({
      tracks,
      languages: ["zh-cn", "en-us"],
      origin: "ja-jp",
      active,
      transcribe: true,
      transcribing: new Set(),
    });
    expect([...lyricsPlan.selection.keys()]).toEqual([1, 2]);
    expect([...lyricsPlan.selection.get(1)!.targets]).toEqual(["zh-cn"]);
    expect([...lyricsPlan.selection.get(2)!.targets]).toEqual(["en-us"]);
    expect([...lyricsPlan.transcribe]).toEqual([3]);
    expect(
      lyricsRequestTargets({ tracks, languages: ["zh-cn", "en-us"], plan: lyricsPlan, sourceFiles, active }),
    ).toEqual([
      { audioMediaItemId: 1, targetLanguage: "zh-cn", lyricsLocationId: 111 },
      { audioMediaItemId: 2, targetLanguage: "en-us", lyricsLocationId: 112 },
      { audioMediaItemId: 3, targetLanguage: "zh-cn", lyricsLocationId: 0 },
      { audioMediaItemId: 3, targetLanguage: "en-us", lyricsLocationId: 0 },
    ]);
  });

  it("leaves tracks without lyrics out when transcription is off or already running", () => {
    const off = defaultLyricsPlan({
      tracks,
      languages: ["zh-cn"],
      origin: "ja-jp",
      active: new Map(),
      transcribe: false,
      transcribing: new Set(),
    });
    expect(off.transcribe.size).toBe(0);
    const running = defaultLyricsPlan({
      tracks,
      languages: ["zh-cn"],
      origin: "ja-jp",
      active: new Map(),
      transcribe: true,
      transcribing: new Set([3]),
    });
    expect(running.transcribe.size).toBe(0);
  });

  it("reads active cells from the plan", () => {
    const cells = activeLyricsCells(
      plan([
        {
          language: "ko-kr",
          title: empty,
          description: empty,
          tags: empty,
          files: empty,
          lyrics: [{ audioMediaItemId: 4, state: "queued" }],
        },
      ]),
    );
    expect(cells.get("4:ko-kr")).toBe("queued");
  });
});

describe("Translate with AI estimates", () => {
  it("sums the missing text of the chosen categories per language", () => {
    const estimates = requestEstimates(
      plan([
        {
          language: "zh-cn",
          title: { missing: 1, active: 0, characters: 12 },
          description: { missing: 1, active: 0, characters: 300 },
          tags: { missing: 2, active: 0, characters: 8 },
          files: empty,
          lyrics: [],
        },
      ]),
      ["title", "tags"],
      [{ audioMediaItemId: 1, targetLanguage: "zh-cn", lyricsLocationId: 111 }],
    );
    expect(estimates).toEqual([{ language: "zh-cn", items: 4, characters: 20, lyricsTracks: 1 }]);
  });
});

describe("direct speech output", () => {
  const service = { translations: { "example-model": { source: "ja-jp", target: "zh-cn" } } };
  it("applies when the one transcribed language is the model's direction", () => {
    expect(directASRLanguage(service, "example-model", "ja-jp", ["zh-cn"])).toBe("zh-cn");
  });
  it("does not apply with a second language, another direction, or a plain model", () => {
    expect(directASRLanguage(service, "example-model", "ja-jp", ["zh-cn", "en-us"])).toBeNull();
    expect(directASRLanguage(service, "example-model", "ja-jp", ["en-us"])).toBeNull();
    expect(directASRLanguage({}, "example-model", "ja-jp", ["zh-cn"])).toBeNull();
  });
});

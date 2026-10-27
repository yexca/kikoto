import { describe, expect, it } from "vitest";

import type { TranslationPlan } from "@/lib/translationApi";
import {
  activeLyricsCells,
  anyLyricsDirection,
  chooseLyricsSource,
  defaultLyricsPlan,
  lyricsCellOpen,
  lyricsFileLanguage,
  lyricsLanguageChoice,
  lyricsRequestTargets,
  lyricsTrackChoice,
  requestEstimates,
  resultsSection,
  runningProgress,
  toggleLyricsCell,
  toggleLyricsLanguage,
  toggleLyricsTrack,
  type LyricsCellContext,
  type LyricsDirection,
  type LyricsPlan,
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
    attributionEnabled: true,
    autoAccept: true,
  };
}

const empty = { missing: 0, active: 0, characters: 0 };

describe("Translate with AI lyrics planning", () => {
  it("translates only missing cells from a lyrics file, and leaves tracks without lyrics out", () => {
    const active = new Map([["1:en-us", "ready" as const]]);
    const lyricsPlan = defaultLyricsPlan({ tracks, languages: ["zh-cn", "en-us"], origin: "ja-jp", active });
    expect([...lyricsPlan.selection.keys()]).toEqual([1, 2]);
    expect([...lyricsPlan.selection.get(1)!.targets]).toEqual(["zh-cn"]);
    expect([...lyricsPlan.selection.get(2)!.targets]).toEqual(["en-us"]);
    // Every request entry names the lyrics file it translates.
    expect(
      lyricsRequestTargets({ tracks, languages: ["zh-cn", "en-us"], plan: lyricsPlan, sourceFiles, active }),
    ).toEqual([
      { audioMediaItemId: 1, targetLanguage: "zh-cn", lyricsLocationId: 111 },
      { audioMediaItemId: 2, targetLanguage: "en-us", lyricsLocationId: 112 },
    ]);
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

describe("Translate with AI results sections", () => {
  it("lists running items as in progress and leaves discarded and cancelled ones out", () => {
    expect(resultsSection("queued")).toBe("active");
    expect(resultsSection("ready")).toBe("review");
    expect(resultsSection("policy_blocked")).toBe("attention");
    expect(resultsSection("accepted")).toBe("history");
    expect(resultsSection("rejected")).toBeNull();
    expect(resultsSection("cancelled")).toBeNull();
  });
});

describe("Translate with AI lyrics track list", () => {
  const none = { selection: new Map() };
  const context = (lyricsPlan: LyricsPlan, active = new Map()): LyricsCellContext => ({
    plan: lyricsPlan,
    origin: "ja-jp",
    active,
    translates: anyLyricsDirection,
  });

  it("chooses a language for every track that can create it, then clears it from all of them", () => {
    const active = new Map([["2:en-us", "requesting" as const]]);
    const chosen = toggleLyricsLanguage(tracks, "en-us", context(none, active));
    // Track 2 is already translating English, and track 3 has nothing to read.
    expect([...chosen.selection.keys()]).toEqual([1]);
    expect(chosen.selection.get(1)).toEqual({ source: "ja-jp", targets: new Set(["en-us"]) });
    expect(toggleLyricsLanguage(tracks, "en-us", context(chosen, active)).selection.size).toBe(0);
  });

  it("says whether a language is chosen for every track that can create it", () => {
    expect(lyricsLanguageChoice(tracks, "en-us", context(none))).toBe("none");
    const one = toggleLyricsLanguage([tracks[0]], "en-us", context(none));
    expect(lyricsLanguageChoice(tracks, "en-us", context(one))).toBe("some");
    const all = toggleLyricsLanguage(tracks, "en-us", context(none));
    expect(lyricsLanguageChoice(tracks, "en-us", context(all))).toBe("all");
    // Every track already has Japanese lyrics or nothing to read.
    expect(lyricsLanguageChoice(tracks, "ja-jp", context(none))).toBeNull();
  });

  it("chooses cells one by one, and every language of one track", () => {
    const languages = ["zh-cn", "en-us"];
    const cell = toggleLyricsCell(tracks[0], "en-us", context(none));
    expect(cell.selection.get(1)).toEqual({ source: "ja-jp", targets: new Set(["en-us"]) });
    expect(lyricsTrackChoice(tracks[0], languages, context(cell))).toBe("some");
    const row = toggleLyricsTrack(tracks[0], languages, context(cell));
    expect(row.selection.get(1)?.targets).toEqual(new Set(["en-us", "zh-cn"]));
    expect(toggleLyricsTrack(tracks[0], languages, context(row)).selection.has(1)).toBe(false);
    // A track without lyrics has nothing to choose.
    expect(lyricsTrackChoice(tracks[2], languages, context(none))).toBeNull();
    // Only the chosen cells are sent.
    expect(lyricsRequestTargets({ tracks, languages, plan: cell, sourceFiles, active: new Map() })).toEqual([
      { audioMediaItemId: 1, targetLanguage: "en-us", lyricsLocationId: 111 },
    ]);
  });
});

describe("Translate with AI lyrics directions", () => {
  // The model translates only Japanese into Simplified Chinese.
  const translates: LyricsDirection = (source, target) => (source === "" || source === "ja-jp") && target === "zh-cn";
  const directed: PlanTrack[] = [
    // Japanese lyrics.
    { audioId: 1, lyrics: new Map([["ja-jp", 11]]) },
    // English lyrics only.
    { audioId: 2, lyrics: new Map([["en-us", 12]]) },
    // Fallback lyrics of unknown language.
    { audioId: 3, lyrics: new Map([["", 13]]) },
    // The fallback is the same file as its Korean lyrics.
    {
      audioId: 4,
      lyrics: new Map([
        ["", 14],
        ["ko-kr", 14],
      ]),
    },
    // English and Japanese lyrics of an English work.
    {
      audioId: 5,
      lyrics: new Map([
        ["en-us", 15],
        ["ja-jp", 25],
      ]),
    },
  ];
  const files = new Map(
    [11, 12, 13, 14, 15, 25].map((id) => [
      id,
      { locationId: id * 10, title: `${id}.lrc`, remote: false, sourceName: "" },
    ]),
  );

  it("checks each track by the language of the lyrics file it reads", () => {
    expect(lyricsFileLanguage(directed[2], "")).toBe("");
    expect(lyricsFileLanguage(directed[3], "")).toBe("ko-kr");
    const lyricsPlan = defaultLyricsPlan({
      tracks: directed,
      languages: ["zh-cn", "en-us"],
      origin: "en-us",
      active: new Map(),
      translates,
    });
    // English and Korean lyrics are refused; unknown fallback lyrics are not.
    // A track with Japanese lyrics among others reads them.
    expect([...lyricsPlan.selection.keys()]).toEqual([1, 3, 5]);
    expect(lyricsPlan.selection.get(5)).toEqual({ source: "ja-jp", targets: new Set(["zh-cn"]) });
    expect(
      lyricsRequestTargets({
        tracks: directed,
        languages: ["zh-cn", "en-us"],
        plan: lyricsPlan,
        sourceFiles: files,
        active: new Map(),
        translates,
      }),
    ).toEqual([
      { audioMediaItemId: 1, targetLanguage: "zh-cn", lyricsLocationId: 110 },
      { audioMediaItemId: 3, targetLanguage: "zh-cn", lyricsLocationId: 130 },
      { audioMediaItemId: 5, targetLanguage: "zh-cn", lyricsLocationId: 250 },
    ]);
  });

  it("leaves out a chosen cell the lyrics it reads cannot become", () => {
    const cellContext = { plan: none(), origin: "", active: new Map(), translates };
    // English cannot be chosen from any lyrics.
    expect(lyricsCellOpen(directed[0], "en-us", cellContext)).toBe(false);
    expect(lyricsLanguageChoice(directed, "en-us", cellContext)).toBeNull();
    // Reading the English lyrics instead drops the chosen Simplified Chinese.
    const chosen = toggleLyricsCell(directed[4], "zh-cn", cellContext);
    expect(chosen.selection.get(5)?.source).toBe("ja-jp");
    const english = chooseLyricsSource(chosen, directed[4], "en-us");
    expect(lyricsCellOpen(directed[4], "zh-cn", { ...cellContext, plan: english })).toBe(false);
    expect(
      lyricsRequestTargets({
        tracks: directed,
        languages: ["zh-cn"],
        plan: english,
        sourceFiles: files,
        active: new Map(),
        translates,
      }),
    ).toEqual([]);
  });
});

function none(): LyricsPlan {
  return { selection: new Map() };
}

describe("Translate with AI results progress", () => {
  it("counts the finished items of the runs that are still working", () => {
    expect(runningProgress([{ runId: 1, state: "accepted" }])).toBeNull();
    expect(
      runningProgress([
        { runId: 1, state: "accepted" },
        { runId: 2, state: "accepted" },
        { runId: 2, state: "failed" },
        { runId: 2, state: "requesting" },
        { runId: 2, state: "queued" },
      ]),
    ).toEqual({ done: 2, total: 4 });
  });
});

import { describe, expect, it } from "vitest";

import {
  runLanguageStage,
  translationCenterViewFromSearch,
  visibleTranslationCenterViews,
} from "./translationCenterModel";

describe("Translation page views", () => {
  it("opens the view a link names", () => {
    expect(translationCenterViewFromSearch("")).toBeNull();
    expect(translationCenterViewFromSearch("?view=coverage")).toBe("coverage");
    expect(translationCenterViewFromSearch("?view=unknown")).toBeNull();
  });

  it("shows the review inbox only while items wait for review", () => {
    expect(visibleTranslationCenterViews(true, 0)).toEqual(["running", "attention", "history", "coverage"]);
    expect(visibleTranslationCenterViews(true, 2)[0]).toBe("review");
    expect(visibleTranslationCenterViews(false, 0)[0]).toBe("review");
  });
});

describe("run language stages", () => {
  const language = (states: Record<string, number>) => ({
    language: "zh-cn",
    states,
    total: Object.values(states).reduce((sum, count) => sum + count, 0),
    chunksDone: 0,
    chunks: 0,
  });

  it("waits for the transcription before translating", () => {
    expect(runLanguageStage(language({ waiting_transcription: 3 })).stage).toBe("waiting");
  });

  it("translates while a request is out or some items are done", () => {
    expect(runLanguageStage(language({ requesting: 1, queued: 2 }))).toMatchObject({
      stage: "translating",
      done: 0,
      total: 3,
    });
    expect(runLanguageStage(language({ ready: 2, queued: 2 }))).toMatchObject({
      stage: "translating",
      done: 2,
      total: 4,
    });
  });

  it("waits for review once every item is translated", () => {
    expect(runLanguageStage(language({ ready: 2, accepted: 1 }))).toMatchObject({ stage: "review", count: 2 });
  });

  it("reports stopped items once nothing waits for review", () => {
    expect(runLanguageStage(language({ accepted: 1, failed: 1 }))).toMatchObject({ stage: "stopped", count: 1 });
    expect(runLanguageStage(language({ accepted: 2 }))).toMatchObject({ stage: "done", count: 2 });
  });
});

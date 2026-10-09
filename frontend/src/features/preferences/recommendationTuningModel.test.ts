import { describe, expect, it } from "vitest";

import type { RecommendationConfig } from "@/lib/api";
import {
  recommendationExampleBreakdown,
  recommendationMatchesToCap,
  recommendationOrderingRange,
  recommendationScoreRange,
} from "./recommendationTuningModel";

const config: RecommendationConfig = {
  affinityBase: 35,
  unmarkedSlots: 12,
  wantSlots: 4,
  listeningSlots: 4,
  finishedSlots: 2,
  relistenSlots: 2,
  shelvedSlots: 0,
  tagWeight: 5,
  tagCap: 25,
  voiceWeight: 10,
  voiceCap: 20,
  circleWeight: 15,
  circleCap: 15,
  favoriteBonus: 10,
  negativeMinEvidence: 2,
  negativeTagWeight: 2,
  negativeTagCap: 6,
  negativeVoiceWeight: 3,
  negativeVoiceCap: 6,
  negativeCircleWeight: 5,
  negativeCircleCap: 5,
  negativeTotalCap: 15,
  jitterAmplitude: 3,
  explorationAmplitude: 18,
};

describe("recommendation tuning preview", () => {
  it("applies per-match weights, caps, the favorite bonus, and shelved deductions like the server", () => {
    const breakdown = recommendationExampleBreakdown(config, {
      tags: 7,
      voices: 1,
      circles: 0,
      favorite: true,
      shelvedTags: 5,
    });
    expect(breakdown.components.map(({ key, contribution }) => [key, contribution])).toEqual([
      ["base", 35],
      ["tags", 25],
      ["voices", 10],
      ["circles", 0],
      ["favorite", 10],
      ["paused_similarity", -6],
    ]);
    expect(breakdown.rawScore).toBe(74);
    expect(breakdown.score).toBe(74);
  });

  it("bounds the displayed score while keeping the raw total", () => {
    const breakdown = recommendationExampleBreakdown(
      { ...config, affinityBase: 90 },
      { tags: 5, voices: 2, circles: 1, favorite: false, shelvedTags: 0 },
    );
    expect(breakdown.rawScore).toBe(150);
    expect(breakdown.score).toBe(100);
  });

  it("reports the reachable score range and when caps saturate", () => {
    expect(recommendationScoreRange(config)).toEqual({ min: 20, max: 100, rawMax: 105 });
    expect(recommendationMatchesToCap(5, 25)).toBe(5);
    expect(recommendationMatchesToCap(15, 20)).toBe(2);
    expect(recommendationMatchesToCap(0, 25)).toBeNull();
  });

  it("gives weaker scores more discovery room while variation stays symmetric", () => {
    expect(recommendationOrderingRange(config, 35)).toEqual({ discovery: 11.7, min: -3, max: 14.7 });
    expect(recommendationOrderingRange(config, 100)).toEqual({ discovery: 0, min: -3, max: 3 });
  });
});

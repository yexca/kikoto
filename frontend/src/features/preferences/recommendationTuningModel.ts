import type { RecommendationAffinityBreakdown, RecommendationConfig } from "@/lib/api";

export type RecommendationExample = {
  tags: number;
  voices: number;
  circles: number;
  favorite: boolean;
  shelvedTags: number;
};

export const defaultRecommendationExample: RecommendationExample = {
  tags: 2,
  voices: 1,
  circles: 1,
  favorite: false,
  shelvedTags: 0,
};

type Components = RecommendationAffinityBreakdown["components"];

/**
 * Mirrors the server's affinity formula for a settings preview. Each example
 * match stands for one supporting work; the server additionally discounts
 * common tags and strengthens repeated evidence, so real scores can differ.
 */
export function recommendationExampleBreakdown(
  config: RecommendationConfig,
  example: RecommendationExample,
): { score: number; rawScore: number; components: Components } {
  const tags = Math.min(config.tagCap, example.tags * config.tagWeight);
  const voices = Math.min(config.voiceCap, example.voices * config.voiceWeight);
  const circles = Math.min(config.circleCap, example.circles * config.circleWeight);
  const favorite = example.favorite ? config.favoriteBonus : 0;
  // A shelved tag counts once enough shelved works share it (negativeMinEvidence).
  const deduction = Math.min(
    config.negativeTotalCap,
    Math.min(config.negativeTagCap, example.shelvedTags * config.negativeTagWeight),
  );
  const rawScore = config.affinityBase + tags + voices + circles + favorite - deduction;
  return {
    score: Math.min(100, Math.max(0, rawScore)),
    rawScore,
    components: [
      { key: "base", label: "", matchCount: 0, contribution: config.affinityBase, cap: 100 },
      { key: "tags", label: "", matchCount: example.tags, contribution: tags, cap: config.tagCap },
      { key: "voices", label: "", matchCount: example.voices, contribution: voices, cap: config.voiceCap },
      { key: "circles", label: "", matchCount: example.circles, contribution: circles, cap: config.circleCap },
      {
        key: "favorite",
        label: "",
        matchCount: example.favorite ? 1 : 0,
        contribution: favorite,
        cap: config.favoriteBonus,
      },
      {
        key: "paused_similarity",
        label: "",
        matchCount: example.shelvedTags,
        contribution: -deduction,
        cap: config.negativeTotalCap,
      },
    ],
  };
}

/** The lowest and highest affinity the configuration can produce, before and after bounding. */
export function recommendationScoreRange(config: RecommendationConfig) {
  const rawMax = config.affinityBase + config.tagCap + config.voiceCap + config.circleCap + config.favoriteBonus;
  const rawMin = config.affinityBase - config.negativeTotalCap;
  return {
    min: Math.min(100, Math.max(0, rawMin)),
    max: Math.min(100, Math.max(0, rawMax)),
    rawMax,
  };
}

/** Ranking movement for one score: discovery lifts weaker scores, variation moves both ways. */
export function recommendationOrderingRange(config: RecommendationConfig, score: number) {
  const discovery = (config.explorationAmplitude * (100 - score)) / 100;
  return {
    discovery,
    min: -config.jitterAmplitude,
    max: discovery + config.jitterAmplitude,
  };
}

/** Matches needed before a per-match weight reaches its cap; null when the weight has no effect. */
export function recommendationMatchesToCap(weight: number, cap: number) {
  if (weight <= 0 || cap <= 0) return null;
  return Math.ceil(cap / weight);
}

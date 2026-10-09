import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mobileDiagnostics", () => ({ recordApiError: vi.fn() }));

import { api, ApiError, type RecommendationAffinityBreakdown } from "@/lib/api";

import { loadRecommendationExplanation } from "./recommendationExplanation";

const affinity: RecommendationAffinityBreakdown = {
  algorithmVersion: "heuristic-v6",
  lane: "unmarked",
  score: 66,
  rawScore: 66,
  signals: {
    listeningStatus: "none",
    favorite: false,
    positiveTagMatches: 1,
    positiveVoiceMatches: 0,
    positiveCircleMatches: 0,
    negativeTagMatches: 0,
    negativeVoiceMatches: 0,
    negativeCircleMatches: 0,
  },
  components: [{ key: "tag", label: "Tags", matchCount: 1, contribution: 16, cap: 30 }],
};
const request = { workID: 1, sessionID: "original-session", seed: 123, contextID: "original-context" };

afterEach(() => vi.restoreAllMocks());

describe("recommendation explanation recovery", () => {
  it("preserves ordering from an applicable query context", async () => {
    const breakdown = {
      ...affinity,
      ordering: { seed: 123, explorationBoost: 2, jitter: 1, totalAdjustment: 3, rankingScore: 69 },
    };
    const getRecommendation = vi.spyOn(api, "getWorkRecommendation").mockResolvedValueOnce(breakdown);

    await expect(loadRecommendationExplanation(request)).resolves.toBe(breakdown);
    expect(getRecommendation).toHaveBeenCalledExactlyOnceWith(1, "original-session", 123, "original-context");
  });

  it("recovers expired query context from the same frozen session without ordering", async () => {
    const getRecommendation = vi
      .spyOn(api, "getWorkRecommendation")
      .mockRejectedValueOnce(new ApiError("Context expired", 410, "recommendation_context_expired"))
      .mockResolvedValueOnce({
        ...affinity,
        ordering: { seed: 123, explorationBoost: 2, jitter: 1, totalAdjustment: 3, rankingScore: 69 },
      });

    await expect(loadRecommendationExplanation(request)).resolves.toEqual(affinity);
    expect(getRecommendation.mock.calls).toEqual([
      [1, "original-session", 123, "original-context"],
      [1, "original-session", 123],
    ]);
  });

  it.each([
    new ApiError("Invalid context", 400, "invalid_request"),
    new ApiError("Unavailable", 503, "service_unavailable", true),
    new ApiError("Gone", 410, "unknown_error"),
  ])("keeps identity and unrelated failures visible: $code", async (error) => {
    const getRecommendation = vi.spyOn(api, "getWorkRecommendation").mockRejectedValueOnce(error);

    await expect(loadRecommendationExplanation(request)).rejects.toBe(error);
    expect(getRecommendation).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...request, contextID: "" },
    { ...request, sessionID: "" },
  ])("does not invent a session or context for recovery", async (input) => {
    const error = new ApiError("Context expired", 410, "recommendation_context_expired");
    const getRecommendation = vi.spyOn(api, "getWorkRecommendation").mockRejectedValueOnce(error);

    await expect(loadRecommendationExplanation(input)).rejects.toBe(error);
    expect(getRecommendation).toHaveBeenCalledTimes(1);
  });
});

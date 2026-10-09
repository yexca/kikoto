import { api, ApiError, type RecommendationBreakdown } from "@/lib/api";

export async function loadRecommendationExplanation({
  workID,
  sessionID,
  seed,
  contextID,
}: {
  workID: number;
  sessionID: string;
  seed?: number;
  contextID: string;
}): Promise<RecommendationBreakdown> {
  try {
    return await api.getWorkRecommendation(workID, sessionID, seed, contextID);
  } catch (error) {
    if (
      !contextID ||
      !sessionID ||
      !(error instanceof ApiError) ||
      error.status !== 410 ||
      error.code !== "recommendation_context_expired"
    ) {
      throw error;
    }
    const breakdown = await api.getWorkRecommendation(workID, sessionID, seed);
    if (breakdown.scoreKind === "demo_random") return breakdown;
    const affinity = { ...breakdown };
    delete affinity.ordering;
    return affinity;
  }
}

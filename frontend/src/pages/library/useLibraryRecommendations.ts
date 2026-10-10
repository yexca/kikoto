import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { api, type RecommendationBreakdown, type RecommendationEventInput, type Work } from "@/lib/api";
import { readOrCreateRecommendationSession, RECOMMENDATION_ALGORITHM_VERSION } from "@/lib/recommendationSession";

import { loadRecommendationExplanation } from "./recommendationExplanation";

/** The recommendation context of the list on screen; null when it is not recommendation-sorted. */
export type RecommendationListContext = { id: string; seed: number };

export type RecommendationExplanationState = {
  work: Work;
  breakdown: RecommendationBreakdown | null;
  loading: boolean;
  error: string;
};

const recommendBadgesStorageKey = "kikoto:recommend-badges";

/**
 * Recommendation interaction of the Library: the client session, the score
 * badge preference, telemetry for the list on screen, and the explanation
 * dialog.
 */
export function useLibraryRecommendations(storageScope: string) {
  const auth = useAuth();
  const { t } = useTranslation();
  const session = useMemo(
    () => readOrCreateRecommendationSession(storageScope, RECOMMENDATION_ALGORITHM_VERSION),
    [storageScope],
  );
  const [badgesEnabled, setBadgesEnabled] = useState(
    () => window.localStorage.getItem(recommendBadgesStorageKey) === "true",
  );
  const [explanation, setExplanation] = useState<RecommendationExplanationState | null>(null);
  const listContextRef = useRef<RecommendationListContext | null>(null);

  const setListContext = useCallback((context: RecommendationListContext | null) => {
    listContextRef.current = context;
  }, []);

  const recordEvents = useCallback(
    (events: RecommendationEventInput[]) => {
      if (!auth.user || auth.demoMode || events.length === 0) return;
      void api.recordRecommendationEvents(events).catch(() => {});
    },
    [auth.demoMode, auth.user],
  );

  /** Records an interaction with a work of the recommendation-sorted list; `listedWorks` gives its rank. */
  const recordWorkEvent = (work: Work, eventType: RecommendationEventInput["eventType"], listedWorks: Work[]) => {
    const context = listContextRef.current;
    if (!context) return;
    const rank = Math.max(0, listedWorks.findIndex((candidate) => candidate.id === work.id) + 1);
    recordEvents([
      {
        workId: work.id,
        eventType,
        contextId: context.id,
        algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
        seed: context.seed,
        rank,
        score: work.recommendScore,
      },
    ]);
  };

  const recordReshuffle = () => {
    const context = listContextRef.current;
    if (!context) return;
    recordEvents([
      {
        eventType: "reshuffle",
        contextId: context.id,
        algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
        seed: context.seed,
      },
    ]);
  };

  const toggleBadges = () => {
    setBadgesEnabled((current) => {
      const next = !current;
      window.localStorage.setItem(recommendBadgesStorageKey, String(next));
      return next;
    });
  };

  /** `browseSeed` explains a work of a list that carries no recommendation context. */
  const openExplanation = (work: Work, browseSeed: number) => {
    setExplanation({ work, breakdown: null, loading: true, error: "" });
    void loadRecommendationExplanation({
      workID: work.id,
      sessionID: session.id,
      seed: listContextRef.current?.seed ?? browseSeed,
      contextID: listContextRef.current?.id ?? "",
    })
      .then((breakdown) => {
        setExplanation((current) =>
          current?.work.id === work.id ? { ...current, breakdown, loading: false, error: "" } : current,
        );
      })
      .catch((error) => {
        setExplanation((current) =>
          current?.work.id === work.id
            ? {
                ...current,
                loading: false,
                error: error instanceof Error ? error.message : t("errors.unavailable"),
              }
            : current,
        );
      });
  };

  return {
    session,
    badgesEnabled,
    toggleBadges,
    explanation,
    openExplanation,
    closeExplanation: () => setExplanation(null),
    setListContext,
    recordEvents,
    recordWorkEvent,
    recordReshuffle,
  };
}

export type LibraryRecommendations = ReturnType<typeof useLibraryRecommendations>;

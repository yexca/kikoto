import { useEffect, useState } from "react";

import { api, type RemoteWork } from "@/lib/api";

const emptyScores = new Map<string, number>();

export function useRemoteRecommendations({
  sourceId,
  works,
  sessionId,
  enabled,
}: {
  sourceId: number;
  works: RemoteWork[];
  sessionId: string;
  enabled: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const candidates = JSON.stringify(
    works
      .filter((work) => work.primaryCode)
      .map(({ primaryCode, workId, tags, voiceActors, circle }) => ({
        primaryCode,
        workId,
        tags,
        voiceActors,
        circle,
      })),
  );
  const key = JSON.stringify([sourceId, sessionId, candidates, attempt]);
  const [result, setResult] = useState<{ key: string; scores: Map<string, number>; failed: boolean } | null>(null);

  useEffect(() => {
    if (!enabled || candidates === "[]") return;
    const controller = new AbortController();
    void api
      .scoreRemoteRecommendations(
        sourceId,
        {
          recommendationSession: sessionId,
          works: JSON.parse(candidates) as Array<
            Pick<RemoteWork, "primaryCode" | "workId" | "tags" | "voiceActors" | "circle">
          >,
        },
        controller.signal,
      )
      .then(({ scores }) => {
        if (!controller.signal.aborted) {
          setResult({
            key,
            scores: new Map(scores.map(({ primaryCode, score }) => [primaryCode, score])),
            failed: false,
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, scores: emptyScores, failed: true });
      });
    return () => controller.abort();
  }, [enabled, sourceId, sessionId, candidates, key]);

  const current = enabled && result?.key === key ? result : null;
  return {
    scores: current?.scores ?? emptyScores,
    failed: current?.failed ?? false,
    retry: () => setAttempt((value) => value + 1),
  };
}

export function recommendationRevealDelay(index: number) {
  return Math.min(Math.max(0, index) * 40, 480);
}

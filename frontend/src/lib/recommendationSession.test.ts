import { describe, expect, it } from "vitest";

import { readOrCreateRecommendationSession, recommendationSeedForSessionID } from "./recommendationSession";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("recommendation client session", () => {
  it("reuses one session and seed within the same server and user scope", () => {
    const storage = memoryStorage();
    const first = readOrCreateRecommendationSession(
      "example.invalid:user-1",
      "heuristic-v3",
      storage,
      () => "session-a",
    );
    const second = readOrCreateRecommendationSession(
      "example.invalid:user-1",
      "heuristic-v3",
      storage,
      () => "session-b",
    );

    expect(second).toEqual(first);
    expect(first.seed).toBeGreaterThanOrEqual(1);
    expect(first.seed).toBeLessThanOrEqual(2147483646);
  });

  it("separates server, user, and algorithm sessions", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const createID = () => `session-${++sequence}`;

    const first = readOrCreateRecommendationSession("one.invalid:user-1", "heuristic-v3", storage, createID);
    const otherUser = readOrCreateRecommendationSession("one.invalid:user-2", "heuristic-v3", storage, createID);
    const otherServer = readOrCreateRecommendationSession("two.invalid:user-1", "heuristic-v3", storage, createID);
    const otherAlgorithm = readOrCreateRecommendationSession("one.invalid:user-1", "heuristic-v4", storage, createID);

    expect(new Set([first.id, otherUser.id, otherServer.id, otherAlgorithm.id]).size).toBe(4);
  });

  it("derives a stable seed from the session id", () => {
    expect(recommendationSeedForSessionID("session-a")).toBe(recommendationSeedForSessionID("session-a"));
    expect(recommendationSeedForSessionID("session-a")).not.toBe(recommendationSeedForSessionID("session-b"));
  });
});

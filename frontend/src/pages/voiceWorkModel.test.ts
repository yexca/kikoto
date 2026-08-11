import { describe, expect, it } from "vitest";

import type { VoiceKnownWork, VoiceRemoteSourceSet, VoiceRemoteWork } from "@/lib/api";
import { workDetailRoute } from "../app/workDetailNavigation";

import { mergeVoiceWorks, voiceWorkRemoteTarget } from "./voiceWorkModel";

describe("mergeVoiceWorks", () => {
  it("keeps known identity while retaining the exact live remote observation", () => {
    const known = knownWork();
    const remote = remoteWork();
    const [merged] = mergeVoiceWorks([known], [sourceSet(remote)]);

    expect("workId" in merged && merged.workId).toBe(11);
    expect("remote" in merged && merged.remote).toBe(false);
    expect("sourceTags" in merged ? merged.sourceTags : []).toContainEqual(
      expect.objectContaining({
        sourceId: 7,
        status: "available",
      }),
    );
    expect(voiceWorkRemoteTarget(merged)).toEqual({ sourceId: 7, code: "SAMPLE-TRANSLATION" });
  });

  it("does not treat a failed source response as an availability observation", () => {
    const result = mergeVoiceWorks([knownWork()], [{ ...sourceSet(remoteWork()), status: "unavailable" }]);
    expect(result[0]).not.toHaveProperty("remoteObservations");
  });

  it("keeps the persisted exact source route when live source search fails", () => {
    const known: VoiceKnownWork = {
      ...knownWork(),
      remoteObservations: [
        {
          sourceId: 9,
          sourceCode: "persisted-source",
          sourceName: "Persisted Source",
          remoteCode: "PERSISTED-REMOTE-EDITION",
          status: "available",
        },
      ],
    };
    const [merged] = mergeVoiceWorks(
      [known],
      [{ ...sourceSet(remoteWork()), sourceId: 9, status: "error", works: [] }],
    );
    const target = voiceWorkRemoteTarget(merged);

    expect(target).toEqual({ sourceId: 9, code: "PERSISTED-REMOTE-EDITION" });
    expect(
      workDetailRoute({
        kind: "known",
        canonicalCode: merged.primaryCode,
        source: target ? { sourceId: target.sourceId, remoteCode: target.code } : null,
      }),
    ).toBe("/SAMPLE-ORIGIN?view=remote&source=9&remoteCode=PERSISTED-REMOTE-EDITION");
  });

  it("prefers the persisted exact edition when live search also returns the canonical edition", () => {
    const persisted = remoteWork();
    const known: VoiceKnownWork = {
      ...knownWork(),
      remoteObservations: [
        {
          sourceId: persisted.sourceId,
          sourceCode: persisted.sourceCode,
          sourceName: persisted.sourceName,
          remoteCode: persisted.remoteCode,
          status: "available",
        },
      ],
    };
    const origin = { ...persisted, remoteCode: "SAMPLE-ORIGIN" };
    const [merged] = mergeVoiceWorks([known], [{ ...sourceSet(origin), works: [origin, persisted], total: 2 }]);

    expect(known.remoteCode).toBe("");
    expect(voiceWorkRemoteTarget(merged)).toEqual({ sourceId: 7, code: "SAMPLE-TRANSLATION" });
  });

  it("prefers the known exact edition when several remote editions share an identity", () => {
    const known = { ...knownWork(), remoteCode: "SAMPLE-TRANSLATION" };
    const origin = { ...remoteWork(), remoteCode: "SAMPLE-ORIGIN" };
    const translation = remoteWork();
    const [merged] = mergeVoiceWorks([known], [{ ...sourceSet(origin), works: [origin, translation], total: 2 }]);

    expect(voiceWorkRemoteTarget(merged)).toEqual({ sourceId: 7, code: "SAMPLE-TRANSLATION" });
  });

  it("sorts local works before newer catalog-only works", () => {
    const local = {
      ...knownWork(),
      primaryCode: "RJ00000008",
      releaseDate: "2024-01-01",
      local: true,
    };
    const remote = {
      ...remoteWork(),
      primaryCode: "RJ00000009",
      remoteCode: "RJ00000009",
      releaseDate: "2026-01-01",
    };

    const result = mergeVoiceWorks([local], [sourceSet(remote)]);

    expect(result.map((work) => work.primaryCode)).toEqual(["RJ00000008", "RJ00000009"]);
  });

  it("keeps persisted negative observations visible without exposing a remote action target", () => {
    const unavailable = {
      ...remoteWork(),
      primaryCode: "RJ00000009",
      remoteCode: "RJ00000009",
      remotePlayable: false,
      hasRemote: false,
      availability: "not_found",
    };

    const [result] = mergeVoiceWorks([], [{ ...sourceSet(unavailable), status: "error" }]);

    expect(result.primaryCode).toBe("RJ00000009");
    expect(result.remoteObservations).toContainEqual(expect.objectContaining({ status: "not_found" }));
    expect(voiceWorkRemoteTarget(result)).toBeNull();
  });
});

function knownWork(): VoiceKnownWork {
  return {
    workId: 11,
    primaryCode: "SAMPLE-ORIGIN",
    remoteCode: "",
    title: "Sample work",
    releaseDate: null,
    updatedAt: "",
    coverUrl: "",
    dlsiteUrl: "",
    circle: "Sample circle",
    circleExternalId: "SAMPLE-CIRCLE",
    ageRating: "",
    rating: null,
    sales: null,
    regularPrice: null,
    price: null,
    priceCurrency: "JPY",
    permanentlyFree: null,
    tags: [],
    userTags: [],
    voiceActors: [],
    voiceCredits: [],
    series: "",
    seriesTitleId: "",
    listeningMark: "none",
    favorite: false,
    local: false,
    remote: false,
    cache: false,
    sourceTags: [],
    progress: {
      workId: null,
      mediaWorkId: null,
      mediaItemId: null,
      fileSourceId: null,
      locationId: null,
      locationType: "",
      positionSeconds: 0,
      durationSeconds: 0,
      lastPlayedAt: null,
      completed: false,
      title: "",
    },
  };
}

function remoteWork(): VoiceRemoteWork {
  return {
    sourceId: 7,
    sourceCode: "sample-source",
    sourceName: "Sample Source",
    remoteId: "501",
    primaryCode: "sample-origin",
    remoteCode: "SAMPLE-TRANSLATION",
    title: "Remote sample",
    releaseDate: "",
    updatedAt: "",
    coverUrl: "",
    circle: "Sample circle",
    ageRating: "",
    rating: null,
    sales: null,
    price: null,
    tags: [],
    voiceActors: [],
    importStatus: "known",
    remotePlayable: true,
    workId: 11,
    hasLocal: false,
    hasCache: false,
    hasRemote: false,
  };
}

function sourceSet(work: VoiceRemoteWork): VoiceRemoteSourceSet {
  return {
    sourceId: work.sourceId,
    sourceCode: work.sourceCode,
    displayName: work.sourceName,
    status: "ok",
    error: "",
    elapsedMs: 1,
    total: 1,
    works: [work],
  };
}

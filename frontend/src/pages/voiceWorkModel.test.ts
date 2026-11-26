import { describe, expect, it } from "vitest";

import type { VoiceKnownWork, VoiceRemoteObservation, VoiceRemoteWork } from "@/lib/api";
import { workDetailRoute } from "../lib/workDetailNavigation";

import { voiceWorkObservedSourceTags, voiceWorkRemoteTarget, type VoiceWorkView } from "./voiceWorkModel";

describe("voiceWorkRemoteTarget", () => {
  it("routes a known work to the first available observation the server lists", () => {
    const known: VoiceKnownWork = {
      ...knownWork(),
      remoteObservations: [observation("SAMPLE-TRANSLATION", "available"), observation("SAMPLE-ORIGIN", "available")],
    };
    const target = voiceWorkRemoteTarget(known);

    expect(target).toEqual({ sourceId: 7, code: "SAMPLE-TRANSLATION" });
    expect(
      workDetailRoute({
        kind: "known",
        canonicalCode: known.primaryCode,
        source: target ? { sourceId: target.sourceId, remoteCode: target.code } : null,
      }),
    ).toBe("/SAMPLE-ORIGIN?view=remote&source=7&remoteCode=SAMPLE-TRANSLATION");
  });

  it("skips an observation that is not available", () => {
    const known: VoiceKnownWork = {
      ...knownWork(),
      remoteObservations: [observation("SAMPLE-ORIGIN", "not_found"), observation("SAMPLE-TRANSLATION", "available")],
    };
    expect(voiceWorkRemoteTarget(known)).toEqual({ sourceId: 7, code: "SAMPLE-TRANSLATION" });
  });

  it("falls back to the remote catalog work's own source", () => {
    expect(voiceWorkRemoteTarget(remoteWork())).toEqual({ sourceId: 7, code: "SAMPLE-TRANSLATION" });
  });

  it("keeps a negative observation visible without exposing a remote action target", () => {
    const unavailable: VoiceWorkView = {
      ...remoteWork(),
      remotePlayable: false,
      hasRemote: false,
      availability: "not_found",
      remoteObservations: [observation("SAMPLE-TRANSLATION", "not_found")],
    };

    expect(voiceWorkRemoteTarget(unavailable)).toBeNull();
    expect(voiceWorkObservedSourceTags(unavailable)).toEqual([
      expect.objectContaining({ sourceId: 7, status: "not_found", count: 0 }),
    ]);
  });
});

function observation(remoteCode: string, status: VoiceRemoteObservation["status"]): VoiceRemoteObservation {
  return { sourceId: 7, sourceCode: "sample-source", sourceName: "Sample Source", remoteCode, status };
}

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

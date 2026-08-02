import { describe, expect, it } from "vitest";

import type { VoiceKnownWork } from "@/lib/api";
import { voiceWorkIsExplicitlyUnavailable } from "./voiceWorkAvailabilityModel";

describe("voiceWorkIsExplicitlyUnavailable", () => {
  it("does not classify an unobserved or unknown work as unavailable", () => {
    expect(voiceWorkIsExplicitlyUnavailable(knownWork())).toBe(false);
    expect(voiceWorkIsExplicitlyUnavailable(knownWork("unknown"))).toBe(false);
    expect(voiceWorkIsExplicitlyUnavailable(knownWork("error"))).toBe(false);
  });

  it("requires an explicit negative source observation", () => {
    expect(voiceWorkIsExplicitlyUnavailable(knownWork("not_found"))).toBe(true);
    expect(voiceWorkIsExplicitlyUnavailable(knownWork("unavailable"))).toBe(true);
  });

  it("does not report unavailable when another source is available", () => {
    const work = knownWork("not_found");
    work.sourceTags.push({
      key: "source:8",
      sourceId: 8,
      displayName: "Available source",
      status: "available",
      count: 1,
    });
    expect(voiceWorkIsExplicitlyUnavailable(work)).toBe(false);
  });
});

function knownWork(status?: string): VoiceKnownWork {
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
    sourceTags: status ? [{
      key: "source:7",
      sourceId: 7,
      displayName: "Observed source",
      status,
      count: 0,
    }] : [],
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

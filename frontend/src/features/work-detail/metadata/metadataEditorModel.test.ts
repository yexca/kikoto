import { describe, expect, it } from "vitest";
import {
  metadataEditorInitialState,
  normalizedMetadataLinkCode,
  workMetadataOverridePayload,
} from "./metadataEditorModel";

describe("metadata editor model", () => {
  it("prefers authored overrides and retains canonical credit identities", () => {
    const work = {
      title: "Example Work",
      circle: "Example Circle",
      circleExternalId: "example-circle",
      series: "Example Series",
      seriesTitleId: "example-series",
      seriesCircleExternalId: "",
      voiceCredits: [{ displayName: "Example Voice", personId: 7 }],
      voiceActors: ["Legacy name"],
      manualOverrides: { title: "Authored title" },
    } satisfies Parameters<typeof metadataEditorInitialState>[0];
    expect(metadataEditorInitialState(work)).toMatchObject({
      title: "Authored title",
      voiceActors: [{ name: "Example Voice", personId: 7 }],
    });
    expect(metadataEditorInitialState({ ...work, voiceCredits: [] }).voiceActors).toEqual([
      { name: "Legacy name", personId: 0 },
    ]);
  });

  it("clears blank overrides while preserving an entity selected by id", () => {
    expect(
      workMetadataOverridePayload({
        title: "  ",
        circleName: " ",
        circleExternalId: " example-circle ",
        seriesName: " ",
        seriesTitleId: "",
        seriesCircleExternalId: "",
        voiceActors: [
          { name: " Example Voice ", personId: 7 },
          { name: " ", personId: 0 },
        ],
      }),
    ).toEqual({
      title: null,
      circle: { name: "", externalId: "example-circle" },
      series: null,
      voiceActors: [{ name: "Example Voice", personId: 7 }],
    });
  });

  it("accepts only another DLsite code as a metadata link", () => {
    expect(normalizedMetadataLinkCode(" rj00000001 ", "RJ00000000")).toBe("RJ00000001");
    expect(normalizedMetadataLinkCode("rj00000000", "RJ00000000")).toBeNull();
    expect(normalizedMetadataLinkCode("RJ0000", "RJ00000000")).toBeNull();
    expect(normalizedMetadataLinkCode("https://example.test/RJ00000001", "RJ00000000")).toBeNull();
  });
});

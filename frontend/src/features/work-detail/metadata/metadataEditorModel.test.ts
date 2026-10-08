import { describe, expect, it } from "vitest";
import {
  coverFieldStatus,
  manualValueStatus,
  metadataEditorInitialState,
  normalizedMetadataLinkCode,
  payloadChangesCredits,
  providerCoverSource,
  workFamilyEditions,
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
      workMetadataOverridePayload(
        {
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
        },
        {
          title: "Initial title",
          circleName: "Initial circle",
          circleExternalId: "",
          seriesName: "Initial series",
          seriesTitleId: "",
          seriesCircleExternalId: "",
          voiceActors: [],
        },
      ),
    ).toEqual({
      title: null,
      circle: { name: "", externalId: "example-circle" },
      series: null,
      voiceActors: [{ name: "Example Voice", personId: 7 }],
    });
  });

  it("submits normalized differences and leaves untouched projected fields unfrozen", () => {
    const initial = {
      title: "Projected title",
      circleName: "Synthetic circle",
      circleExternalId: "RG00000000",
      seriesName: "Synthetic series",
      seriesTitleId: "SRI0000000000",
      seriesCircleExternalId: "RG00000000",
      voiceActors: [{ name: "Synthetic voice", personId: 1 }],
    };
    expect(workMetadataOverridePayload(initial, initial)).toEqual({});
    expect(workMetadataOverridePayload({ ...initial, title: " Projected title " }, initial)).toEqual({});
    expect(workMetadataOverridePayload({ ...initial, title: "Authored title" }, initial)).toEqual({
      title: "Authored title",
    });
    expect(workMetadataOverridePayload({ ...initial, voiceActors: [] }, initial)).toEqual({ voiceActors: [] });
  });

  it("stages a revert as an explicit removal that wins over a discarded draft", () => {
    const initial = {
      title: "Projected title",
      circleName: "Manual circle",
      circleExternalId: "",
      seriesName: "Manual series",
      seriesTitleId: "",
      seriesCircleExternalId: "",
      voiceActors: [{ name: "Manual voice", personId: 0 }],
    };
    const payload = workMetadataOverridePayload({ ...initial, circleName: "Abandoned draft" }, initial, {
      circle: true,
      voiceActors: true,
    });
    expect(payload).toEqual({ circle: null, voiceActors: [] });
    expect(payloadChangesCredits(payload)).toBe(true);
    expect(payloadChangesCredits(workMetadataOverridePayload(initial, initial, { series: false }))).toBe(false);
  });

  it("accepts only another DLsite code as a metadata link", () => {
    expect(normalizedMetadataLinkCode(" rj00000001 ", "RJ00000000")).toBe("RJ00000001");
    expect(normalizedMetadataLinkCode("rj00000000", "RJ00000000")).toBeNull();
    expect(normalizedMetadataLinkCode("RJ0000", "RJ00000000")).toBeNull();
    expect(normalizedMetadataLinkCode("https://example.test/RJ00000001", "RJ00000000")).toBeNull();
  });
});

describe("manual value status", () => {
  it("separates inherited, own, edited, and staged-removal rows", () => {
    expect(manualValueStatus(undefined, undefined)).toBe("source");
    expect(manualValueStatus(" ", undefined)).toBe("source");
    expect(manualValueStatus(undefined, "Own")).toBe("manual");
    expect(manualValueStatus(" Own ", "Own")).toBe("manual");
    expect(manualValueStatus("Draft", undefined)).toBe("edited");
    expect(manualValueStatus("Draft", "Own")).toBe("edited");
    expect(manualValueStatus("", "Own")).toBe("reverting");
  });
});

describe("cover choice", () => {
  it("names a remote source only when it filled the cover", () => {
    expect(providerCoverSource({ status: "available", checkedAt: "" })).toBe("");
    expect(
      providerCoverSource({
        status: "remote_fallback",
        checkedAt: "",
        source: "Example Remote A",
        fields: [{ field: "cover", source: "Example Remote B" }],
      }),
    ).toBe("Example Remote B");
  });

  it("reports a staged return to the original cover before the changed selection", () => {
    const manualCover = { assetPath: "covers/1.png", originalPath: "RJ00000000/cover.png", url: "/cover.png" };
    expect(coverFieldStatus({ manualCover, selectedCoverId: null, initialCoverId: 7, reverted: true })).toBe(
      "reverting",
    );
    expect(coverFieldStatus({ selectedCoverId: null, initialCoverId: null, reverted: false })).toBe("source");
  });

  it("lists a family's original edition first, then by language and code", () => {
    const edition = (primaryCode: string, metadataLanguage: string, origin = false) => ({
      workId: null,
      primaryCode,
      title: primaryCode,
      metadataLanguage,
      editionLabel: "",
      origin,
      official: !origin,
      translationKind: origin ? ("origin" as const) : ("official" as const),
      current: false,
      hasMedia: false,
      mediaState: "metadata_only" as const,
      localAvailable: false,
    });
    expect(
      workFamilyEditions([
        edition("RJ00000012", "zh-cn"),
        edition("RJ00000011", "en-us"),
        edition("RJ00000003", "zh-cn"),
        edition("RJ00000010", "ja-jp", true),
      ]).map((item) => item.primaryCode),
    ).toEqual(["RJ00000010", "RJ00000011", "RJ00000003", "RJ00000012"]);
  });
});

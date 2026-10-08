import { describe, expect, it } from "vitest";

import {
  metadataSyncBlockers,
  metadataSyncDefaultValues,
  metadataSyncPayload,
  metadataSyncValuesFromConfig,
  metadataSyncWorkCodes,
  metadataSyncSources,
  metadataSyncSelectScope,
} from "./metadataSyncModel";

describe("metadataSyncModel", () => {
  it("defaults to every work with missing metadata", () => {
    const values = metadataSyncDefaultValues();
    expect(metadataSyncPayload(values)).toEqual({
      scope: "all",
      mode: "missing",
      remoteMetadataFallback: { enabled: false, sourceIds: [] },
      purchaseBonusAutoLink: true,
    });
    expect(metadataSyncBlockers(values)).toEqual([]);
  });

  it("sends only the target of the selected scope", () => {
    const values = { ...metadataSyncDefaultValues(), circleId: " rg00000 ", personId: "7", mode: "full" as const };
    expect(metadataSyncPayload({ ...values, scope: "circle" })).toMatchObject({
      scope: "circle",
      mode: "full",
      circleId: "RG00000",
    });
    expect(metadataSyncPayload({ ...values, scope: "voice", sourceId: 1 })).toMatchObject({
      scope: "voice",
      mode: "full",
      personId: 7,
    });
  });

  it("requires a valid target for a circle or voice actor scope", () => {
    const values = metadataSyncDefaultValues();
    expect(metadataSyncBlockers({ ...values, scope: "circle", circleId: "RJ00000001" })).toEqual(["circle_required"]);
    expect(metadataSyncBlockers({ ...values, scope: "voice", sourceId: 1 })).toEqual(["voice_required"]);
  });

  it("restores a stored trigger config and ignores unknown values", () => {
    expect(metadataSyncValuesFromConfig({})).toEqual(metadataSyncDefaultValues());
    expect(metadataSyncValuesFromConfig({ scope: "voice", personId: 7, mode: "full" })).toMatchObject({
      scope: "voice",
      personId: "7",
      mode: "full",
    });
    expect(metadataSyncValuesFromConfig({ scope: "everything", mode: "deep" })).toMatchObject({
      scope: "all",
      mode: "missing",
    });
  });

  it("normalizes pasted codes and round-trips every trigger option", () => {
    expect(metadataSyncWorkCodes("rj00000002，RJ00000001\nrj00000002")).toEqual(["RJ00000001", "RJ00000002"]);
    const payload = {
      scope: "works" as const,
      mode: "full" as const,
      workCodes: ["RJ00000001", "RJ00000002"],
      remoteMetadataFallback: { enabled: true, sourceIds: [2, 1] },
      purchaseBonusAutoLink: false,
    };
    expect(metadataSyncPayload(metadataSyncValuesFromConfig(payload))).toEqual(payload);
    expect(metadataSyncBlockers({ ...metadataSyncDefaultValues(), scope: "works", workCodes: "invalid" })).toEqual([
      "works_required",
    ]);
  });

  it("uses DLsite for circles and an enabled remote for voice actors across scope changes", () => {
    const sources = [
      {
        id: 1,
        code: "example_remote_a",
        displayName: "Example Remote A",
        sourceType: "kikoeru_compatible",
        enabled: true,
      },
      {
        id: 2,
        code: "example_remote_b",
        displayName: "Example Remote B",
        sourceType: "kikoeru_compatible",
        enabled: true,
      },
    ];
    const values = { ...metadataSyncDefaultValues(), circleId: "RG00000", personId: "7" };
    const voice = metadataSyncSelectScope(values, "voice", sources);
    expect(metadataSyncPayload(voice)).toEqual({ scope: "voice", mode: "missing", personId: 7, sourceId: 1 });
    expect(metadataSyncBlockers(voice, sources)).toEqual([]);
    expect(metadataSyncSelectScope({ ...voice, sourceId: 2 }, "voice", sources).sourceId).toBe(2);
    const circle = metadataSyncSelectScope(voice, "circle", sources);
    expect(metadataSyncPayload(circle)).toEqual({
      scope: "circle",
      mode: "missing",
      circleId: "RG00000",
      remoteMetadataFallback: { enabled: false, sourceIds: [] },
      purchaseBonusAutoLink: true,
    });
    expect(metadataSyncValuesFromConfig({ scope: "circle", sourceId: 2 }).sourceId).toBe(0);
    expect(metadataSyncBlockers({ ...voice, sourceId: 0 }, sources)).toEqual(["voice_source_required"]);
    expect(
      metadataSyncBlockers(
        voice,
        sources.map((source) => ({ ...source, enabled: false })),
      ),
    ).toEqual(["voice_source_required"]);
    expect(
      metadataSyncBlockers(
        voice,
        sources.map((source) => ({ ...source, metadataCapable: false })),
      ),
    ).toEqual(["voice_source_required"]);
    expect(metadataSyncBlockers({ ...voice, sourceId: 3 }, sources)).toEqual(["source_required"]);
  });

  it("remote runs omit DLsite options and require a capable enabled source", () => {
    const sources = [
      {
        id: 1,
        code: "example_remote_a",
        displayName: "Example Remote A",
        sourceType: "kikoeru_compatible",
        enabled: true,
      },
      {
        id: 2,
        code: "example_remote_b",
        displayName: "Example Remote B",
        sourceType: "kikoeru_compatible",
        enabled: true,
        metadataCapable: false,
      },
      {
        id: 3,
        code: "example_remote_c",
        displayName: "Example Remote C",
        sourceType: "kikoeru_compatible",
        enabled: false,
      },
    ];
    expect(metadataSyncSources(sources).map((source) => source.id)).toEqual([1]);
    const values = {
      ...metadataSyncDefaultValues(),
      sourceId: 1,
      remoteMetadataFallback: { enabled: true, sourceIds: [] },
      purchaseBonusAutoLink: false,
    };
    expect(metadataSyncPayload(values)).toEqual({ scope: "all", mode: "missing", sourceId: 1 });
    expect(metadataSyncBlockers(values, sources)).toEqual([]);
    expect(metadataSyncBlockers({ ...values, sourceId: 2 }, sources)).toEqual(["source_required"]);
    expect(metadataSyncBlockers({ ...values, sourceId: 0 }, sources)).toEqual(["fallback_required"]);
  });
});

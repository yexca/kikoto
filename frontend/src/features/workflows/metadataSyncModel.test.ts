import { describe, expect, it } from "vitest";

import {
  metadataSyncBlockers,
  metadataSyncDefaultValues,
  metadataSyncPayload,
  metadataSyncValuesFromConfig,
} from "./metadataSyncModel";

describe("metadataSyncModel", () => {
  it("defaults to every work with missing metadata", () => {
    const values = metadataSyncDefaultValues();
    expect(metadataSyncPayload(values)).toEqual({ scope: "all", mode: "missing" });
    expect(metadataSyncBlockers(values)).toEqual([]);
  });

  it("sends only the target of the selected scope", () => {
    const values = { ...metadataSyncDefaultValues(), circleId: " rg12345 ", personId: "7", mode: "full" as const };
    expect(metadataSyncPayload({ ...values, scope: "circle" })).toEqual({
      scope: "circle",
      mode: "full",
      circleId: "RG12345",
    });
    expect(metadataSyncPayload({ ...values, scope: "voice" })).toEqual({ scope: "voice", mode: "full", personId: 7 });
  });

  it("requires a valid target for a circle or voice actor scope", () => {
    const values = metadataSyncDefaultValues();
    expect(metadataSyncBlockers({ ...values, scope: "circle", circleId: "RJ00000001" })).toEqual(["circle_required"]);
    expect(metadataSyncBlockers({ ...values, scope: "voice" })).toEqual(["voice_required"]);
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
});

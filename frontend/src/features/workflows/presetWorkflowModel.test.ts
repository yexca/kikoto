import { describe, expect, it } from "vitest";

import {
  presetBlockers,
  presetDefaultValues,
  presetInputsNeedReconfiguration,
  presetInputsPayload,
  presetOptionalEnabled,
  presetOptionalFlagKey,
  presetReleaseRange,
  presetRunsUnfiltered,
  presetTagEnabled,
  PRESET_RELEASE_KEYS,
  presetValuesFromInputs,
  PRESET_TAG_ENABLED_KEY,
  presetVisibleParameters,
} from "./presetWorkflowModel";
import type { WorkflowPreset } from "@/lib/api";

const circleFollow: WorkflowPreset = {
  code: "circle_follow",
  displayName: "Follow a circle",
  description: "",
  target: "circle",
  defaultTagTemplate: "{date}_circle_{target}",
  parameters: [
    { key: "circleId", kind: "circle_id", group: "input", required: true },
    {
      key: "catalogRefresh",
      kind: "select",
      group: "input",
      required: false,
      default: "incremental",
      options: ["incremental", "full"],
    },
    { key: "releaseFrom", kind: "date", group: "filter", required: false },
    { key: "releaseTo", kind: "date", group: "filter", required: false },
    { key: "maxWorks", kind: "integer", group: "filter", required: false, default: 25, minimum: 1, maximum: 500 },
    { key: "metadata", kind: "boolean", group: "action", required: false, default: true },
    { key: "tagNameTemplate", kind: "text_template", group: "action", required: false, tokens: ["date", "target"] },
    { key: "checkSourceIds", kind: "source_ids", group: "action", required: false },
  ],
};

const seriesFollow: WorkflowPreset = {
  ...circleFollow,
  code: "series_follow",
  target: "series",
  parameters: [
    { key: "seriesId", kind: "series_id", group: "input", required: true },
    ...circleFollow.parameters.slice(2, 7),
  ],
};

const options = { canTag: true, automated: false };

describe("presetWorkflowModel", () => {
  it("starts with the filter off, metadata on, and the preset tag template", () => {
    const values = presetDefaultValues(circleFollow);
    expect(values.metadata).toBe("true");
    expect(presetOptionalEnabled(values, "maxWorks")).toBe(false);
    expect(presetReleaseRange(values).enabled).toBe(false);
    expect(values.tagNameTemplate).toBe("{date}_circle_{target}");
    expect(presetRunsUnfiltered(circleFollow, { ...values, circleId: "RG12345" })).toBe(true);
  });

  it("sends no work limit while the limit is off and restores a stored limit as on", () => {
    const base = { ...presetDefaultValues(circleFollow), circleId: "rg12345" };
    expect(presetInputsPayload(circleFollow, base)).toEqual({
      circleId: "rg12345",
      catalogRefresh: "incremental",
      metadata: true,
      tagNameTemplate: "{date}_circle_{target}",
    });
    const limited = { ...base, [presetOptionalFlagKey("maxWorks")]: "true", maxWorks: "10" };
    expect(presetInputsPayload(circleFollow, limited).maxWorks).toBe(10);
    expect(presetRunsUnfiltered(circleFollow, limited)).toBe(false);

    const restored = presetValuesFromInputs(circleFollow, { circleId: "RG12345", maxWorks: 40 });
    expect(presetOptionalEnabled(restored, "maxWorks")).toBe(true);
    expect(restored.maxWorks).toBe("40");
    expect(presetOptionalEnabled(presetValuesFromInputs(circleFollow, { circleId: "RG12345" }), "maxWorks")).toBe(
      false,
    );
  });

  it("drops the filter and the tag when the metadata action is off", () => {
    const values = {
      ...presetDefaultValues(circleFollow),
      circleId: "RG12345",
      metadata: "false",
      releaseEnabled: "true",
      releaseFrom: "2025-01-01",
      [presetOptionalFlagKey("maxWorks")]: "true",
    };
    expect(presetVisibleParameters(circleFollow, values).map((parameter) => parameter.key)).toEqual([
      "circleId",
      "catalogRefresh",
      "metadata",
      "checkSourceIds",
    ]);
    expect(presetInputsPayload(circleFollow, values)).toEqual({
      circleId: "RG12345",
      catalogRefresh: "incremental",
      metadata: false,
    });
    expect(presetBlockers(circleFollow, values, options)).toEqual([]);
    expect(presetRunsUnfiltered(circleFollow, values)).toBe(false);
  });

  it("reports blockers that mirror the server rules", () => {
    const base = presetDefaultValues(circleFollow);
    expect(presetBlockers(circleFollow, base, options)).toEqual([{ kind: "required", key: "circleId" }]);
    expect(
      presetBlockers(
        circleFollow,
        { ...base, circleId: "RG1", [presetOptionalFlagKey("maxWorks")]: "true", maxWorks: "501" },
        options,
      ),
    ).toEqual([{ kind: "range", key: "maxWorks", minimum: 1, maximum: 500 }]);
    expect(
      presetBlockers(
        circleFollow,
        { ...base, circleId: "RG1", catalogRefresh: "full" },
        { ...options, automated: true },
      ),
    ).toEqual([{ kind: "full_refresh_automated" }]);
    expect(
      presetBlockers(
        circleFollow,
        { ...base, circleId: "RG1", releaseFrom: "2025/1/1", releaseEnabled: "true" },
        options,
      ),
    ).toEqual([{ kind: "invalid_date", key: "releaseFrom" }]);
    expect(presetBlockers(circleFollow, { ...base, circleId: "RG1" }, { ...options, canTag: false })).toEqual([
      { kind: "tag_permission" },
    ]);
    expect(
      presetBlockers(
        seriesFollow,
        { ...presetDefaultValues(seriesFollow), seriesId: "S1", metadata: "false" },
        options,
      ),
    ).toEqual([{ kind: "no_steps" }]);
  });

  it("turns tagging off with an empty template and requires a template while it is on", () => {
    const base = { ...presetDefaultValues(circleFollow), circleId: "RG12345" };
    expect(presetTagEnabled(base)).toBe(true);
    const untagged = { ...base, [PRESET_TAG_ENABLED_KEY]: "false" };
    expect(presetInputsPayload(circleFollow, untagged).tagNameTemplate).toBe("");
    expect(presetBlockers(circleFollow, untagged, { ...options, canTag: false })).toEqual([]);
    expect(presetBlockers(circleFollow, { ...base, tagNameTemplate: " " }, options)).toEqual([
      { kind: "required", key: "tagNameTemplate" },
    ]);

    const restored = presetValuesFromInputs(circleFollow, { circleId: "RG12345", tagNameTemplate: "" });
    expect(presetTagEnabled(restored)).toBe(false);
    expect(restored.tagNameTemplate).toBe("{date}_circle_{target}");
  });

  it("sends an inclusive release range with open ends only while the range is on", () => {
    const base = { ...presetDefaultValues(circleFollow), circleId: "RG12345", releaseFrom: "2025-01-01" };
    expect(presetReleaseRange(base)).toEqual({ enabled: false, fromOpen: false, toOpen: true });
    expect(presetInputsPayload(circleFollow, base)).not.toHaveProperty("releaseFrom");

    const after = { ...base, [PRESET_RELEASE_KEYS.enabled]: "true" };
    expect(presetInputsPayload(circleFollow, after)).toMatchObject({ releaseFrom: "2025-01-01" });
    expect(presetInputsPayload(circleFollow, after)).not.toHaveProperty("releaseTo");
    expect(presetRunsUnfiltered(circleFollow, after)).toBe(false);

    const before = {
      ...after,
      [PRESET_RELEASE_KEYS.fromOpen]: "true",
      [PRESET_RELEASE_KEYS.toOpen]: "false",
      releaseTo: "2025-06-30",
    };
    const beforePayload = presetInputsPayload(circleFollow, before);
    expect(beforePayload).toMatchObject({ releaseTo: "2025-06-30" });
    expect(beforePayload).not.toHaveProperty("releaseFrom");

    expect(presetBlockers(circleFollow, { ...before, releaseTo: "" }, options)).toEqual([
      { kind: "required", key: "releaseTo" },
    ]);
    expect(presetBlockers(circleFollow, { ...before, [PRESET_RELEASE_KEYS.toOpen]: "true" }, options)).toEqual([
      { kind: "release_range_open" },
    ]);
    expect(
      presetBlockers(
        circleFollow,
        { ...before, [PRESET_RELEASE_KEYS.fromOpen]: "false", releaseFrom: "2025-07-01" },
        options,
      ),
    ).toEqual([{ kind: "release_range_order" }]);

    const restored = presetValuesFromInputs(circleFollow, { circleId: "RG12345", releaseTo: "2025-06-30" });
    expect(presetReleaseRange(restored)).toEqual({ enabled: true, fromOpen: true, toOpen: false });
  });

  it("omits a switched-off source check and restores a stored one as on", () => {
    const values = { ...presetDefaultValues(circleFollow), circleId: "RG12345", checkSourceIds: "11" };
    expect(presetInputsPayload(circleFollow, values)).not.toHaveProperty("checkSourceIds");
    const emptyCheck = { ...values, [presetOptionalFlagKey("checkSourceIds")]: "true", checkSourceIds: "" };
    expect(presetBlockers(circleFollow, emptyCheck, options)).toEqual([
      { kind: "sources_required", key: "checkSourceIds" },
    ]);
    const restored = presetValuesFromInputs(circleFollow, { circleId: "RG12345", checkSourceIds: [11] });
    expect(restored[presetOptionalFlagKey("checkSourceIds")]).toBe("true");
  });

  it("keeps what still applies from inputs saved before the follow options changed", () => {
    const legacy = {
      circleId: "RG12345",
      catalogRefresh: "stored",
      newWorks: true,
      action: "fetch",
      sourceId: 91,
      releaseFrom: "2025-01-01",
    };
    expect(presetInputsNeedReconfiguration(legacy)).toBe(true);
    expect(presetInputsNeedReconfiguration({ circleId: "RG12345", metadata: true })).toBe(false);
    const values = presetValuesFromInputs(circleFollow, legacy);
    expect(values.circleId).toBe("RG12345");
    expect(values.catalogRefresh).toBe("incremental");
    expect(values).not.toHaveProperty("action");
    expect(presetInputsPayload(circleFollow, values)).toMatchObject({ releaseFrom: "2025-01-01", metadata: true });
  });
});

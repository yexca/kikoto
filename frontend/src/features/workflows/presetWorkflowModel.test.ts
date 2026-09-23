import { describe, expect, it } from "vitest";

import {
  presetBlockers,
  presetDefaultValues,
  presetInputsPayload,
  presetOptionalEnabled,
  presetOptionalFlagKey,
  presetReleaseRange,
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
    { key: "circleId", kind: "circle_id", group: "target", required: true },
    {
      key: "catalogRefresh",
      kind: "select",
      group: "target",
      required: false,
      default: "incremental",
      options: ["stored", "incremental", "full"],
    },
    {
      key: "existing",
      kind: "select",
      group: "filter",
      required: false,
      default: "unknown",
      options: ["unknown", "any"],
    },
    { key: "releaseFrom", kind: "date", group: "filter", required: false },
    { key: "releaseTo", kind: "date", group: "filter", required: false },
    { key: "maxWorks", kind: "integer", group: "filter", required: false, default: 25, minimum: 1, maximum: 100 },
    {
      key: "action",
      kind: "select",
      group: "action",
      required: false,
      default: "metadata",
      options: ["metadata", "track", "fetch"],
    },
    { key: "sourceId", kind: "source_id", group: "action", required: false },
    { key: "excludeExtensions", kind: "extensions", group: "fetch", required: false },
    { key: "maxFiles", kind: "integer", group: "fetch", required: false, default: 10000, minimum: 1, maximum: 50000 },
    { key: "maxGiB", kind: "integer", group: "fetch", required: false, default: 100, minimum: 1, maximum: 2048 },
    { key: "minFreeGiB", kind: "integer", group: "fetch", required: false, default: 2, minimum: 1, maximum: 1024 },
    {
      key: "tagNameTemplate",
      kind: "text_template",
      group: "tag",
      required: false,
      tokens: ["date", "target", "action"],
    },
  ],
};

describe("presetWorkflowModel", () => {
  it("seeds defaults including the preset tag template", () => {
    const values = presetDefaultValues(circleFollow);
    expect(values.action).toBe("metadata");
    expect(values.maxWorks).toBe("25");
    expect(values.tagNameTemplate).toBe("{date}_circle_{target}");
    expect(values.circleId).toBe("");
  });

  it("hides fetch bounds and the action source until the action needs them", () => {
    const metadataKeys = presetVisibleParameters(circleFollow, presetDefaultValues(circleFollow)).map((p) => p.key);
    expect(metadataKeys).not.toContain("sourceId");
    expect(metadataKeys).not.toContain("maxGiB");
    const fetchKeys = presetVisibleParameters(circleFollow, {
      ...presetDefaultValues(circleFollow),
      action: "fetch",
    }).map((p) => p.key);
    expect(fetchKeys).toContain("sourceId");
    expect(fetchKeys).toContain("maxGiB");
  });

  it("converts form text into a typed payload and drops hidden fields", () => {
    const payload = presetInputsPayload(circleFollow, {
      ...presetDefaultValues(circleFollow),
      circleId: "rg12345",
      action: "fetch",
      sourceId: "91",
      maxWorks: "10",
      excludeExtensions: "WAV, .flac",
      releaseFrom: "",
      tagNameTemplate: "",
    });
    expect(payload).toEqual({
      circleId: "rg12345",
      catalogRefresh: "incremental",
      existing: "unknown",
      maxWorks: 10,
      action: "fetch",
      sourceId: 91,
      excludeExtensions: ["wav", "flac"],
      maxFiles: 10000,
      maxGiB: 100,
      minFreeGiB: 2,
      tagNameTemplate: "",
    });
    expect(
      presetInputsPayload(circleFollow, { ...presetDefaultValues(circleFollow), circleId: "RG1" }),
    ).not.toHaveProperty("maxGiB");
  });

  it("reports blockers that mirror the server rules", () => {
    const base = presetDefaultValues(circleFollow);
    expect(presetBlockers(circleFollow, base, { canFetch: true, automated: false })).toEqual([
      { kind: "required", key: "circleId" },
    ]);
    expect(
      presetBlockers(circleFollow, { ...base, circleId: "RG1", action: "track" }, { canFetch: true, automated: false }),
    ).toEqual([{ kind: "source_required" }]);
    expect(
      presetBlockers(
        circleFollow,
        { ...base, circleId: "RG1", action: "fetch", sourceId: "3", maxWorks: "500" },
        { canFetch: false, automated: false },
      ),
    ).toEqual([{ kind: "range", key: "maxWorks", minimum: 1, maximum: 100 }, { kind: "fetch_permission" }]);
    expect(
      presetBlockers(
        circleFollow,
        { ...base, circleId: "RG1", catalogRefresh: "full" },
        { canFetch: true, automated: true },
      ),
    ).toEqual([{ kind: "full_refresh_automated" }]);
    expect(
      presetBlockers(
        circleFollow,
        { ...base, circleId: "RG1", releaseFrom: "2025/1/1", releaseEnabled: "true" },
        { canFetch: true, automated: false },
      ),
    ).toEqual([{ kind: "invalid_date", key: "releaseFrom" }]);
  });

  it("turns tagging off with an empty template and requires a template while it is on", () => {
    const base = { ...presetDefaultValues(circleFollow), circleId: "RG12345" };
    expect(presetTagEnabled(base)).toBe(true);
    const untagged = { ...base, [PRESET_TAG_ENABLED_KEY]: "false" };
    expect(presetInputsPayload(circleFollow, untagged).tagNameTemplate).toBe("");
    expect(presetBlockers(circleFollow, untagged, { canFetch: true, automated: false })).toEqual([]);
    expect(
      presetBlockers(circleFollow, { ...base, tagNameTemplate: " " }, { canFetch: true, automated: false }),
    ).toEqual([{ kind: "required", key: "tagNameTemplate" }]);

    const restored = presetValuesFromInputs(circleFollow, { circleId: "RG12345", tagNameTemplate: "" });
    expect(presetTagEnabled(restored)).toBe(false);
    expect(restored.tagNameTemplate).toBe("{date}_circle_{target}");
  });

  it("runs at the maximum when the work limit is switched off", () => {
    const base = { ...presetDefaultValues(circleFollow), circleId: "RG12345" };
    expect(presetOptionalEnabled(base, "maxWorks")).toBe(true);
    expect(presetInputsPayload(circleFollow, base).maxWorks).toBe(25);
    const unlimited = { ...base, [presetOptionalFlagKey("maxWorks")]: "false", maxWorks: "500" };
    expect(presetInputsPayload(circleFollow, unlimited).maxWorks).toBe(100);
    expect(presetBlockers(circleFollow, unlimited, { canFetch: true, automated: false })).toEqual([]);

    const restored = presetValuesFromInputs(circleFollow, { circleId: "RG12345", maxWorks: 100 });
    expect(presetOptionalEnabled(restored, "maxWorks")).toBe(false);
    expect(restored.maxWorks).toBe("25");
  });

  it("sends an inclusive release range with open ends only while the range is on", () => {
    const base = { ...presetDefaultValues(circleFollow), circleId: "RG12345", releaseFrom: "2025-01-01" };
    expect(presetReleaseRange(base)).toEqual({ enabled: false, fromOpen: false, toOpen: true });
    expect(presetInputsPayload(circleFollow, base)).not.toHaveProperty("releaseFrom");

    const after = { ...base, [PRESET_RELEASE_KEYS.enabled]: "true" };
    expect(presetInputsPayload(circleFollow, after)).toMatchObject({ releaseFrom: "2025-01-01" });
    expect(presetInputsPayload(circleFollow, after)).not.toHaveProperty("releaseTo");

    const before = {
      ...after,
      [PRESET_RELEASE_KEYS.fromOpen]: "true",
      [PRESET_RELEASE_KEYS.toOpen]: "false",
      releaseTo: "2025-06-30",
    };
    const beforePayload = presetInputsPayload(circleFollow, before);
    expect(beforePayload).toMatchObject({ releaseTo: "2025-06-30" });
    expect(beforePayload).not.toHaveProperty("releaseFrom");

    const options = { canFetch: true, automated: false };
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

  it("restores stored trigger inputs into form values", () => {
    const values = presetValuesFromInputs(circleFollow, {
      circleId: "RG12345",
      action: "fetch",
      sourceId: 91,
      excludeExtensions: ["wav"],
      ignored: "x",
    });
    expect(values.circleId).toBe("RG12345");
    expect(values.sourceId).toBe("91");
    expect(values.excludeExtensions).toBe("wav");
    expect(values).not.toHaveProperty("ignored");
    expect(values.maxWorks).toBe("25");
  });
});

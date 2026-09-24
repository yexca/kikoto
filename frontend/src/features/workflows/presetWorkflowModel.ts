import type { WorkflowPreset, WorkflowPresetParameter } from "@/lib/api";

export type PresetFormValues = Record<string, string>;

/** Form-only flag: when "false" the run sends an empty template, which skips tagging. */
export const PRESET_TAG_ENABLED_KEY = "tagEnabled";
const TAG_TEMPLATE_KEY = "tagNameTemplate";

export function presetTagEnabled(values: PresetFormValues) {
  return values[PRESET_TAG_ENABLED_KEY] !== "false";
}

/** Form-only: the picked voice actor's name, used for the tag preview. */
export const PRESET_PERSON_NAME_KEY = "personName";
const SOURCE_CHECK_KEY = "checkSourceIds";
const NEW_WORKS_KEY = "newWorks";
/** Groups that belong to the switchable new-works step. */
const NEW_WORKS_GROUPS = new Set(["filter", "action", "fetch", "tag"]);

/** Source lists are kept as comma-separated ids while editing. */
export function presetSourceIds(raw: string | undefined): number[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((item) => Number(item))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

export function presetNewWorks(values: PresetFormValues) {
  return values[NEW_WORKS_KEY] !== "false";
}

export function presetSourceCheckEnabled(values: PresetFormValues) {
  return values[presetOptionalFlagKey(SOURCE_CHECK_KEY)] === "true";
}

/**
 * Filters the form can switch off, with their default state. A disabled work
 * limit runs at the parameter's maximum, since every preset run keeps an
 * explicit bound.
 */
export const PRESET_OPTIONAL_FILTERS: Record<string, boolean> = { maxWorks: true };

/** Form-only release range flags: the range switch and an open ("No limit") end per side. */
export const PRESET_RELEASE_KEYS = {
  enabled: "releaseEnabled",
  fromOpen: "releaseFromOpen",
  toOpen: "releaseToOpen",
} as const;
const RELEASE_FROM_KEY = "releaseFrom";
const RELEASE_TO_KEY = "releaseTo";

export type PresetReleaseRange = { enabled: boolean; fromOpen: boolean; toOpen: boolean };

/** Both bounds are inclusive; an open end leaves that side unlimited. */
export function presetReleaseRange(values: PresetFormValues): PresetReleaseRange {
  return {
    enabled: values[PRESET_RELEASE_KEYS.enabled] === "true",
    fromOpen: values[PRESET_RELEASE_KEYS.fromOpen] === "true",
    toOpen: values[PRESET_RELEASE_KEYS.toOpen] !== "false",
  };
}

function releaseRangeActiveValue(values: PresetFormValues, key: string) {
  const range = presetReleaseRange(values);
  if (!range.enabled) return null;
  if (key === RELEASE_FROM_KEY && range.fromOpen) return null;
  if (key === RELEASE_TO_KEY && range.toOpen) return null;
  return (values[key] ?? "").trim();
}

export function presetOptionalFlagKey(key: string) {
  return `${key}Enabled`;
}

export function presetOptionalEnabled(values: PresetFormValues, key: string) {
  const flag = values[presetOptionalFlagKey(key)];
  return flag === undefined ? (PRESET_OPTIONAL_FILTERS[key] ?? true) : flag === "true";
}

export type PresetBlocker =
  | { kind: "required"; key: string }
  | { kind: "range"; key: string; minimum: number; maximum: number }
  | { kind: "source_required" }
  | { kind: "fetch_permission" }
  | { kind: "full_refresh_automated" }
  | { kind: "invalid_date"; key: string }
  | { kind: "release_range_open" }
  | { kind: "release_range_order" }
  | { kind: "sources_required"; key: string }
  | { kind: "no_steps" };

export const PRESET_ACTIONS = ["metadata", "track", "fetch"] as const;
export type PresetAction = (typeof PRESET_ACTIONS)[number];

export function presetDefaultValues(preset: WorkflowPreset): PresetFormValues {
  const values: PresetFormValues = {};
  for (const parameter of preset.parameters) {
    if (parameter.key === TAG_TEMPLATE_KEY) {
      values[parameter.key] = preset.defaultTagTemplate;
      values[PRESET_TAG_ENABLED_KEY] = "true";
      continue;
    }
    values[parameter.key] =
      parameter.default === undefined || parameter.default === null ? "" : String(parameter.default);
    if (parameter.key in PRESET_OPTIONAL_FILTERS) {
      values[presetOptionalFlagKey(parameter.key)] = String(PRESET_OPTIONAL_FILTERS[parameter.key]);
    }
    if (parameter.key === SOURCE_CHECK_KEY) values[presetOptionalFlagKey(SOURCE_CHECK_KEY)] = "false";
  }
  if (preset.parameters.some((parameter) => parameter.key === RELEASE_FROM_KEY)) {
    values[PRESET_RELEASE_KEYS.enabled] = "false";
    values[PRESET_RELEASE_KEYS.fromOpen] = "false";
    values[PRESET_RELEASE_KEYS.toOpen] = "true";
  }
  return values;
}

export function presetValuesFromInputs(preset: WorkflowPreset, inputs: unknown): PresetFormValues {
  const values = presetDefaultValues(preset);
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return values;
  for (const [key, value] of Object.entries(inputs as Record<string, unknown>)) {
    if (!(key in values)) continue;
    values[key] = Array.isArray(value) ? value.join(", ") : value === null || value === undefined ? "" : String(value);
  }
  if (presetSourceIds(values[SOURCE_CHECK_KEY]).length > 0) values[presetOptionalFlagKey(SOURCE_CHECK_KEY)] = "true";
  const storedFrom = (values[RELEASE_FROM_KEY] ?? "").trim();
  const storedTo = (values[RELEASE_TO_KEY] ?? "").trim();
  if (storedFrom || storedTo) {
    values[PRESET_RELEASE_KEYS.enabled] = "true";
    values[PRESET_RELEASE_KEYS.fromOpen] = String(!storedFrom);
    values[PRESET_RELEASE_KEYS.toOpen] = String(!storedTo);
  }
  const maxWorks = preset.parameters.find((parameter) => parameter.key === "maxWorks");
  if (maxWorks?.maximum !== undefined && integerValue(values.maxWorks ?? "") === maxWorks.maximum) {
    // Running at the maximum is what a disabled limit sends, so it restores as disabled.
    values[presetOptionalFlagKey("maxWorks")] = "false";
    values.maxWorks = maxWorks.default === undefined || maxWorks.default === null ? "" : String(maxWorks.default);
  }
  if (TAG_TEMPLATE_KEY in values && values[TAG_TEMPLATE_KEY].trim() === "") {
    // A stored empty template means tagging was turned off; keep the default ready to turn it back on.
    values[PRESET_TAG_ENABLED_KEY] = "false";
    values[TAG_TEMPLATE_KEY] = preset.defaultTagTemplate;
  }
  return values;
}

export function presetAction(values: PresetFormValues): PresetAction {
  const action = values.action;
  return action === "track" || action === "fetch" ? action : "metadata";
}

/** Parameters that apply to the enabled steps and the selected action. */
export function presetVisibleParameters(preset: WorkflowPreset, values: PresetFormValues): WorkflowPresetParameter[] {
  const action = presetAction(values);
  const newWorks = presetNewWorks(values);
  return preset.parameters.filter((parameter) => {
    if (!newWorks && NEW_WORKS_GROUPS.has(parameter.group)) return false;
    if (parameter.group === "fetch") return action === "fetch";
    if (parameter.key === "sourceId" && parameter.group === "action") return action !== "metadata";
    return true;
  });
}

function integerValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function presetInputsPayload(preset: WorkflowPreset, values: PresetFormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const parameter of presetVisibleParameters(preset, values)) {
    const raw = (values[parameter.key] ?? "").trim();
    if (parameter.key in PRESET_OPTIONAL_FILTERS && !presetOptionalEnabled(values, parameter.key)) {
      if (parameter.kind === "integer" && parameter.maximum !== undefined) payload[parameter.key] = parameter.maximum;
      continue;
    }
    if (parameter.key === RELEASE_FROM_KEY || parameter.key === RELEASE_TO_KEY) {
      const active = releaseRangeActiveValue(values, parameter.key);
      if (active) payload[parameter.key] = active;
      continue;
    }
    switch (parameter.kind) {
      case "boolean":
        payload[parameter.key] = raw !== "false";
        break;
      case "source_ids":
        if (parameter.key === SOURCE_CHECK_KEY && !presetSourceCheckEnabled(values)) break;
        payload[parameter.key] = presetSourceIds(raw);
        break;
      case "integer":
      case "voice_person":
      case "source_id": {
        const number = integerValue(raw);
        if (number !== null) payload[parameter.key] = number;
        break;
      }
      case "extensions":
        payload[parameter.key] = raw
          .split(/[\s,]+/)
          .map((item) => item.replace(/^\./, "").toLowerCase())
          .filter(Boolean);
        break;
      case "text_template":
        payload[parameter.key] = parameter.key === TAG_TEMPLATE_KEY && !presetTagEnabled(values) ? "" : raw;
        break;
      default:
        if (raw !== "") payload[parameter.key] = raw;
    }
  }
  return payload;
}

export function presetBlockers(
  preset: WorkflowPreset,
  values: PresetFormValues,
  options: { canFetch: boolean; automated: boolean },
): PresetBlocker[] {
  const blockers: PresetBlocker[] = [];
  const action = presetAction(values);
  const newWorks = presetNewWorks(values);
  for (const parameter of presetVisibleParameters(preset, values)) {
    const raw = (values[parameter.key] ?? "").trim();
    if (parameter.key in PRESET_OPTIONAL_FILTERS) {
      if (!presetOptionalEnabled(values, parameter.key)) continue;
      if (raw === "") {
        blockers.push({ kind: "required", key: parameter.key });
        continue;
      }
    }
    if (parameter.key === RELEASE_FROM_KEY || parameter.key === RELEASE_TO_KEY) {
      const active = releaseRangeActiveValue(values, parameter.key);
      if (active === null) continue;
      if (active === "") {
        blockers.push({ kind: "required", key: parameter.key });
        continue;
      }
    }
    if (parameter.key === TAG_TEMPLATE_KEY && presetTagEnabled(values) && raw === "") {
      blockers.push({ kind: "required", key: parameter.key });
      continue;
    }
    if (parameter.required && raw === "" && parameter.kind !== "source_id") {
      blockers.push({ kind: "required", key: parameter.key });
      continue;
    }
    if (parameter.kind === "integer" && raw !== "") {
      const number = integerValue(raw);
      const minimum = parameter.minimum ?? 1;
      const maximum = parameter.maximum ?? Number.MAX_SAFE_INTEGER;
      if (number === null || number < minimum || number > maximum) {
        blockers.push({ kind: "range", key: parameter.key, minimum, maximum });
      }
    }
    if (parameter.kind === "date" && raw !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      blockers.push({ kind: "invalid_date", key: parameter.key });
    }
    if (parameter.kind === "source_ids" && presetSourceIds(raw).length === 0) {
      const needed =
        parameter.key === SOURCE_CHECK_KEY ? presetSourceCheckEnabled(values) : values.catalogRefresh !== "stored";
      if (needed) blockers.push({ kind: "sources_required", key: parameter.key });
    }
  }
  const hasNewWorksStep = preset.parameters.some((parameter) => parameter.key === NEW_WORKS_KEY);
  if (
    hasNewWorksStep &&
    !newWorks &&
    values.catalogRefresh === "stored" &&
    (values.metadataRefresh ?? "off") === "off" &&
    !presetSourceCheckEnabled(values)
  ) {
    blockers.push({ kind: "no_steps" });
  }
  const range = presetReleaseRange(values);
  if (range.enabled && range.fromOpen && range.toOpen) blockers.push({ kind: "release_range_open" });
  const from = releaseRangeActiveValue(values, RELEASE_FROM_KEY);
  const to = releaseRangeActiveValue(values, RELEASE_TO_KEY);
  if (from && to && from > to) blockers.push({ kind: "release_range_order" });
  const needsSource =
    newWorks &&
    (action !== "metadata" ||
      preset.parameters.some((parameter) => parameter.key === "sourceId" && parameter.required));
  if (needsSource && !(integerValue(values.sourceId ?? "") ?? 0)) blockers.push({ kind: "source_required" });
  if (action === "fetch" && !options.canFetch) blockers.push({ kind: "fetch_permission" });
  if (options.automated && values.catalogRefresh === "full") blockers.push({ kind: "full_refresh_automated" });
  return blockers;
}

export function presetTargetValue(preset: WorkflowPreset, values: PresetFormValues) {
  switch (preset.target) {
    case "circle":
      return (values.circleId ?? "").trim().toUpperCase();
    case "series":
      return (values.seriesId ?? "").trim().toUpperCase();
    case "voice":
      return (values[PRESET_PERSON_NAME_KEY] ?? "").trim();
    default:
      return "";
  }
}

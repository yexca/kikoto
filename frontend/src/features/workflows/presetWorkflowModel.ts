import type { WorkflowPreset, WorkflowPresetParameter } from "@/lib/api";

export type PresetFormValues = Record<string, string>;

export type PresetBlocker =
  | { kind: "required"; key: string }
  | { kind: "range"; key: string; minimum: number; maximum: number }
  | { kind: "source_required" }
  | { kind: "fetch_permission" }
  | { kind: "full_refresh_automated" }
  | { kind: "invalid_date"; key: string };

export const PRESET_ACTIONS = ["metadata", "track", "fetch"] as const;
export type PresetAction = (typeof PRESET_ACTIONS)[number];

export function presetDefaultValues(preset: WorkflowPreset): PresetFormValues {
  const values: PresetFormValues = {};
  for (const parameter of preset.parameters) {
    if (parameter.key === "tagNameTemplate") {
      values[parameter.key] = preset.defaultTagTemplate;
      continue;
    }
    values[parameter.key] =
      parameter.default === undefined || parameter.default === null ? "" : String(parameter.default);
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
  return values;
}

export function presetAction(values: PresetFormValues): PresetAction {
  const action = values.action;
  return action === "track" || action === "fetch" ? action : "metadata";
}

/** Parameters that apply to the currently selected action. */
export function presetVisibleParameters(preset: WorkflowPreset, values: PresetFormValues): WorkflowPresetParameter[] {
  const action = presetAction(values);
  return preset.parameters.filter((parameter) => {
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
    switch (parameter.kind) {
      case "integer":
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
        payload[parameter.key] = raw;
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
  for (const parameter of presetVisibleParameters(preset, values)) {
    const raw = (values[parameter.key] ?? "").trim();
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
  }
  const needsSource =
    action !== "metadata" || preset.parameters.some((parameter) => parameter.key === "sourceId" && parameter.required);
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
      return (values.voiceName ?? "").trim();
    default:
      return "";
  }
}

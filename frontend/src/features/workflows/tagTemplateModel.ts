import { presetTargetValue, type PresetFormValues } from "@/features/workflows/presetWorkflowModel";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import type { WorkflowPreset } from "@/lib/api";

/** Tag name templates for preset runs: placeholder tokens, validation, and preview. */

export type WorkflowTagTemplateToken = {
  name: string;
  description: string;
  value: string;
};

export type WorkflowTagTemplatePreview = {
  value: string;
  renderedLength: number;
  truncated: boolean;
};

export const TAG_TEMPLATE_MAX_LENGTH = 160;
export const TAG_NAME_MAX_LENGTH = 40;

export function workflowTagTemplateBlockers(template: string, tokens: string[]) {
  if (!template.trim()) return [workflowCopy("tagTemplateRequired")];
  if ([...template].length > TAG_TEMPLATE_MAX_LENGTH)
    return [workflowCopy("tagTemplateMaxLength", { count: TAG_TEMPLATE_MAX_LENGTH })];
  const matches = template.match(/\{[a-z_]+\}/g) ?? [];
  const unsupported = matches.find((token) => !tokens.includes(token.slice(1, -1)));
  if (unsupported) return [workflowCopy("unsupportedTemplatePlaceholder", { placeholder: unsupported })];
  if (/[{}]/.test(template.replace(/\{[a-z_]+\}/g, ""))) return [workflowCopy("invalidTemplatePlaceholder")];
  return [];
}

export function presetTagTemplateTokens(
  preset: WorkflowPreset,
  values: PresetFormValues,
  now: Date,
): WorkflowTagTemplateToken[] {
  return [
    { name: "date", description: workflowCopy("presetTokens.date"), value: utcShortDate(now) },
    {
      name: "target",
      description: workflowCopy("presetTokens.target"),
      value: workflowTagFragmentPreview(presetTargetValue(preset, values) || preset.target),
    },
  ];
}

export function workflowTagTemplatePreview(
  template: string,
  values: Record<string, string>,
): WorkflowTagTemplatePreview {
  const rendered = template.replace(/\{[a-z_]+\}/g, (token) => values[token.slice(1, -1)] ?? token).trim();
  const runes = [...rendered];
  return {
    value: runes.slice(0, TAG_NAME_MAX_LENGTH).join(""),
    renderedLength: runes.length,
    truncated: runes.length > TAG_NAME_MAX_LENGTH,
  };
}

export function workflowTagTemplateTokenValues(tokens: WorkflowTagTemplateToken[]) {
  return Object.fromEntries(tokens.map((token) => [token.name, token.value]));
}

function workflowTagFragmentPreview(value: string) {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
}

function utcShortDate(value: Date) {
  return `${String(value.getUTCFullYear()).slice(-2)}${String(value.getUTCMonth() + 1).padStart(2, "0")}${String(value.getUTCDate()).padStart(2, "0")}`;
}

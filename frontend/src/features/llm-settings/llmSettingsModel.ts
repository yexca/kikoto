import type { LLMModel, LLMPolicy, LLMProvider, LLMProviderPayload, LLMProviderPreset } from "@/lib/api";

/** One provider as edited in the dialog. `id` is absent until the first save. */
export type ProviderDraft = {
  id?: string;
  presetId: string;
  kind: LLMProvider["kind"];
  name: string;
  baseUrl: string;
  /** The saved origin, so the dialog can tell when an edit replaces the connection. */
  savedBaseUrl: string;
  savedOllamaScope?: LLMProvider["ollamaScope"];
  /** A newly typed key; the stored key never reaches the browser. */
  apiKey: string;
  clearKey: boolean;
  hasApiKey: boolean;
  boundary: LLMProvider["boundary"];
  maxContentClass: LLMProvider["maxContentClass"];
  ollamaScope?: LLMProvider["ollamaScope"];
  enabled: boolean;
  defaultModel: string;
  models: LLMModel[];
};

export function draftFromPreset(preset: LLMProviderPreset): ProviderDraft {
  return {
    presetId: preset.id,
    kind: preset.kind,
    name: "",
    baseUrl: "",
    savedBaseUrl: "",
    apiKey: "",
    clearKey: false,
    hasApiKey: false,
    boundary: preset.boundary,
    maxContentClass: "safe",
    ollamaScope: preset.kind === "ollama" ? "local_machine" : undefined,
    enabled: true,
    defaultModel: "",
    models: [],
  };
}

export function draftFromProvider(provider: LLMProvider): ProviderDraft {
  return {
    id: provider.id,
    presetId: provider.presetId,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    savedBaseUrl: provider.baseUrl,
    savedOllamaScope: provider.ollamaScope,
    apiKey: "",
    clearKey: false,
    hasApiKey: provider.hasApiKey,
    boundary: provider.boundary,
    maxContentClass: provider.maxContentClass,
    ollamaScope: provider.ollamaScope,
    enabled: provider.enabled,
    defaultModel: provider.defaultModel ?? "",
    models: [...provider.models],
  };
}

/** Keeps the preset choice of an unsaved draft in step with what the administrator already typed. */
export function withPreset(draft: ProviderDraft, preset: LLMProviderPreset): ProviderDraft {
  return {
    ...draftFromPreset(preset),
    name: draft.name,
    apiKey: draft.apiKey,
    enabled: draft.enabled,
  };
}

/** A same-machine Ollama is reached at an address the server derives; it takes no endpoint. */
export function usesDerivedEndpoint(draft: Pick<ProviderDraft, "kind" | "ollamaScope">) {
  return draft.kind === "ollama" && draft.ollamaScope === "local_machine";
}

/** A preset without a built-in address, or an Ollama on another machine, needs an endpoint. */
export function endpointMissing(draft: ProviderDraft, preset: LLMProviderPreset | undefined) {
  if (usesDerivedEndpoint(draft) || draft.baseUrl.trim()) return false;
  return !preset?.defaultUrl;
}

/** The server drops the stored key and discovered models when the connection target changes. */
export function replacesConnection(draft: ProviderDraft) {
  if (!draft.id) return false;
  if (draft.ollamaScope !== draft.savedOllamaScope) return true;
  return !usesDerivedEndpoint(draft) && draft.baseUrl.trim() !== draft.savedBaseUrl;
}

export function updatePayload(draft: ProviderDraft): Partial<LLMProviderPayload> {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    defaultModel: draft.defaultModel.trim(),
    boundary: draft.boundary,
    maxContentClass: draft.maxContentClass,
    ollamaScope: draft.ollamaScope,
    ...(usesDerivedEndpoint(draft) ? {} : { baseUrl: draft.baseUrl.trim() }),
    ...(draft.clearKey ? { apiKey: "" } : draft.apiKey ? { apiKey: draft.apiKey } : {}),
  };
}

export function createPayload(draft: ProviderDraft): LLMProviderPayload {
  return { ...updatePayload(draft), presetId: draft.presetId, kind: draft.kind, name: draft.name.trim() };
}

export const KEYWORD_RULE_LIMIT = 512;
export const KEYWORD_RULE_FIELDS = ["all", "title", "description", "tags", "lyrics"] as const;

export function emptyPolicy(): LLMPolicy {
  return { alwaysScanAllAges: false, tagRules: [], keywords: [] };
}

export function policiesEqual(left: LLMPolicy, right: LLMPolicy) {
  const comparable = (policy: LLMPolicy) =>
    JSON.stringify({
      alwaysScanAllAges: policy.alwaysScanAllAges,
      remoteLyrics: policy.remoteLyrics ?? false,
      tagRules: policy.tagRules,
      keywords: policy.keywords.map((rule) => ({ term: rule.term, fields: rule.fields, action: rule.action })),
    });
  return comparable(left) === comparable(right);
}

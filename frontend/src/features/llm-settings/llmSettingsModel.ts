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
  allowSensitive: boolean;
  ollamaScope?: LLMProvider["ollamaScope"];
  enabled: boolean;
  defaultModel: string;
  models: LLMModel[];
  /** Whole minutes as typed; blank uses the server default. */
  requestTimeoutMinutes: string;
  /** Tokens as typed; blank keeps the model default. */
  ollamaContextLength: string;
  ollamaDisableThinking: boolean;
};

/** Mirrors the server bounds of the request settings. */
export const REQUEST_TIMEOUT_MINUTES = { min: 1, max: 60, default: 10 } as const;
export const OLLAMA_CONTEXT_LENGTH = { min: 512, max: 1 << 20 } as const;

function inRange(value: string, bounds: { min: number; max: number }) {
  const number = Number(value);
  return Number.isInteger(number) && number >= bounds.min && number <= bounds.max;
}

export function requestTimeoutInvalid(draft: Pick<ProviderDraft, "requestTimeoutMinutes">) {
  return draft.requestTimeoutMinutes !== "" && !inRange(draft.requestTimeoutMinutes, REQUEST_TIMEOUT_MINUTES);
}

export function contextLengthInvalid(draft: Pick<ProviderDraft, "kind" | "ollamaContextLength">) {
  return (
    draft.kind === "ollama" &&
    draft.ollamaContextLength !== "" &&
    !inRange(draft.ollamaContextLength, OLLAMA_CONTEXT_LENGTH)
  );
}

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
    allowSensitive: false,
    ollamaScope: preset.kind === "ollama" ? "local_machine" : undefined,
    enabled: true,
    defaultModel: "",
    models: [],
    requestTimeoutMinutes: String(REQUEST_TIMEOUT_MINUTES.default),
    ollamaContextLength: "",
    // Translation gains nothing from a reasoning pass, so a new Ollama skips it.
    ollamaDisableThinking: preset.kind === "ollama",
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
    allowSensitive: provider.allowSensitive,
    ollamaScope: provider.ollamaScope,
    enabled: provider.enabled,
    defaultModel: provider.defaultModel ?? "",
    models: [...provider.models],
    requestTimeoutMinutes: String(Math.max(1, Math.round(provider.requestTimeoutSeconds / 60))),
    ollamaContextLength: provider.ollamaContextLength ? String(provider.ollamaContextLength) : "",
    ollamaDisableThinking: provider.ollamaDisableThinking ?? false,
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
    allowSensitive: draft.boundary === "private" && draft.allowSensitive,
    ollamaScope: draft.ollamaScope,
    requestTimeoutSeconds: Number(draft.requestTimeoutMinutes) * 60,
    ...(draft.kind === "ollama"
      ? { ollamaContextLength: Number(draft.ollamaContextLength), ollamaDisableThinking: draft.ollamaDisableThinking }
      : {}),
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
  return { alwaysScanAllAges: false, tagIds: [], keywords: [] };
}

export function policiesEqual(left: LLMPolicy, right: LLMPolicy) {
  const comparable = (policy: LLMPolicy) =>
    JSON.stringify({
      alwaysScanAllAges: policy.alwaysScanAllAges,
      remoteLyrics: policy.remoteLyrics ?? false,
      tagIds: policy.tagIds,
      keywords: policy.keywords.map((rule) => ({ term: rule.term, fields: rule.fields, action: rule.action })),
    });
  return comparable(left) === comparable(right);
}

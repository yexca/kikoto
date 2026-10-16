import type { LLMModel, LLMPolicy, LLMProvider, LLMProviderPayload, LLMProviderPreset, LLMScope } from "@/lib/api";

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
  savedScope?: LLMScope;
  savedPort?: number;
  /** A newly typed key; the stored key never reaches the browser. */
  apiKey: string;
  clearKey: boolean;
  hasApiKey: boolean;
  boundary: LLMProvider["boundary"];
  maxContentClass: LLMProvider["maxContentClass"];
  ollamaScope?: LLMProvider["ollamaScope"];
  /** The location of a local preset; absent for every other provider. */
  scope?: LLMScope;
  /** The port as typed; a local preset on this server's machine needs one. */
  port: string;
  enabled: boolean;
  enabledModels: string[];
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
    maxContentClass: "safe",
    ollamaScope: preset.kind === "ollama" ? "local_machine" : undefined,
    scope: preset.local ? "local_machine" : undefined,
    port: preset.defaultPort ? String(preset.defaultPort) : "",
    enabled: true,
    enabledModels: [],
    defaultModel: "",
    models: [],
    requestTimeoutMinutes: String(REQUEST_TIMEOUT_MINUTES.default),
    ollamaContextLength: "",
    // Translation gains nothing from a reasoning pass, so a new Ollama skips it.
    ollamaDisableThinking: preset.kind === "ollama",
  };
}

export function draftFromProvider(provider: LLMProvider): ProviderDraft {
  // A same-machine local preset address is derived by the server, not an origin to keep.
  const derived = provider.scope === "local_machine";
  return {
    id: provider.id,
    presetId: provider.presetId,
    kind: provider.kind,
    name: provider.name,
    baseUrl: derived ? "" : provider.baseUrl,
    savedBaseUrl: derived ? "" : provider.baseUrl,
    savedOllamaScope: provider.ollamaScope,
    savedScope: provider.scope,
    savedPort: provider.port,
    apiKey: "",
    clearKey: false,
    hasApiKey: provider.hasApiKey,
    boundary: provider.boundary,
    maxContentClass: provider.maxContentClass,
    ollamaScope: provider.ollamaScope,
    scope: provider.scope,
    port: provider.port ? String(provider.port) : "",
    enabled: provider.enabled,
    enabledModels: [...provider.enabledModels],
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

/** A local preset on this server's machine is reached at a host the server derives; only its port is entered. */
export function usesDerivedHost(draft: Pick<ProviderDraft, "scope">) {
  return draft.scope === "local_machine";
}

export function parsedPort(draft: Pick<ProviderDraft, "port">): number | null {
  const value = draft.port.trim();
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

export function portMissing(draft: ProviderDraft) {
  return usesDerivedHost(draft) && parsedPort(draft) === null;
}

/** A preset without a built-in address, or a provider on another machine, needs an endpoint. */
export function endpointMissing(draft: ProviderDraft, preset: LLMProviderPreset | undefined) {
  if (usesDerivedEndpoint(draft) || usesDerivedHost(draft) || draft.baseUrl.trim()) return false;
  return !preset?.defaultUrl;
}

/** The server drops the stored key and discovered models when the connection target changes. */
export function replacesConnection(draft: ProviderDraft) {
  if (!draft.id) return false;
  if (draft.ollamaScope !== draft.savedOllamaScope || draft.scope !== draft.savedScope) return true;
  if (usesDerivedHost(draft)) return parsedPort(draft) !== (draft.savedPort ?? null);
  return !usesDerivedEndpoint(draft) && draft.baseUrl.trim() !== draft.savedBaseUrl;
}

/** A provider that refuses requests without a key needs one that survives the save. */
export function keyMissing(draft: ProviderDraft, preset: LLMProviderPreset | undefined) {
  if (!preset?.keyRequired || draft.apiKey.trim()) return false;
  return !draft.hasApiKey || draft.clearKey || replacesConnection(draft);
}

export function updatePayload(draft: ProviderDraft): Partial<LLMProviderPayload> {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    enabledModels: draft.enabledModels,
    defaultModel: draft.defaultModel,
    boundary: draft.boundary,
    maxContentClass: draft.maxContentClass,
    ollamaScope: draft.ollamaScope,
    requestTimeoutSeconds: Number(draft.requestTimeoutMinutes) * 60,
    ...(draft.kind === "ollama"
      ? { ollamaContextLength: Number(draft.ollamaContextLength), ollamaDisableThinking: draft.ollamaDisableThinking }
      : {}),
    ...(draft.scope ? { scope: draft.scope } : {}),
    ...(usesDerivedHost(draft)
      ? { port: parsedPort(draft) ?? 0 }
      : usesDerivedEndpoint(draft)
        ? {}
        : { baseUrl: draft.baseUrl.trim() }),
    ...(draft.clearKey ? { apiKey: "" } : draft.apiKey ? { apiKey: draft.apiKey } : {}),
  };
}

export function createPayload(draft: ProviderDraft): LLMProviderPayload {
  return { ...updatePayload(draft), presetId: draft.presetId, kind: draft.kind, name: draft.name.trim() };
}

export const KEYWORD_RULE_LIMIT = 512;
export const KEYWORD_RULE_FIELDS = ["all", "title", "description", "tags", "lyrics"] as const;

export function emptyPolicy(): LLMPolicy {
  return { alwaysScanAllAges: false, llmTranslationTextOnly: false, tagRules: [], keywords: [] };
}

export function policiesEqual(left: LLMPolicy, right: LLMPolicy) {
  const comparable = (policy: LLMPolicy) =>
    JSON.stringify({
      alwaysScanAllAges: policy.alwaysScanAllAges,
      remoteLyrics: policy.remoteLyrics ?? false,
      llmTranslationTextOnly: policy.llmTranslationTextOnly ?? false,
      tagRules: policy.tagRules,
      keywords: policy.keywords,
    });
  return comparable(left) === comparable(right);
}

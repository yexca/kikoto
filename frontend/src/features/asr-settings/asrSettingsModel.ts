import type { ASRModel, ASRPreset, ASRProvider, ASRProviderPayload, ASRScope } from "@/lib/api";

/** One speech recognition service as edited in the dialog. `id` is absent until the first save. */
export type ASRServiceDraft = {
  id?: string;
  presetId: string;
  name: string;
  baseUrl: string;
  /** The saved connection, so the dialog can tell when an edit replaces it. */
  savedBaseUrl: string;
  savedScope?: ASRScope;
  savedPort?: number;
  scope?: ASRScope;
  /** The port as typed; a same-machine deployment needs one. */
  port: string;
  /** A newly typed key; the stored key never reaches the browser. */
  apiKey: string;
  clearKey: boolean;
  hasApiKey: boolean;
  boundary: ASRProvider["boundary"];
  maxContentClass: ASRProvider["maxContentClass"];
  enabled: boolean;
  enabledModels: string[];
  defaultModel: string;
  models: ASRModel[];
};

export function draftFromPreset(preset: ASRPreset): ASRServiceDraft {
  return {
    presetId: preset.id,
    name: "",
    baseUrl: "",
    savedBaseUrl: "",
    scope: preset.local ? "local_machine" : undefined,
    port: preset.defaultPort ? String(preset.defaultPort) : "",
    apiKey: "",
    clearKey: false,
    hasApiKey: false,
    boundary: preset.boundary,
    maxContentClass: "safe",
    enabled: true,
    enabledModels: [],
    defaultModel: "",
    models: [],
  };
}

export function draftFromProvider(provider: ASRProvider): ASRServiceDraft {
  const derived = provider.scope === "local_machine";
  return {
    id: provider.id,
    presetId: provider.presetId,
    name: provider.name,
    // A same-machine address is derived by the server, not an origin to keep.
    baseUrl: derived ? "" : provider.baseUrl,
    savedBaseUrl: derived ? "" : provider.baseUrl,
    savedScope: provider.scope,
    savedPort: provider.port,
    scope: provider.scope,
    port: provider.port ? String(provider.port) : "",
    apiKey: "",
    clearKey: false,
    hasApiKey: provider.hasApiKey,
    boundary: provider.boundary,
    maxContentClass: provider.maxContentClass,
    enabled: provider.enabled,
    enabledModels: [...provider.enabledModels],
    defaultModel: provider.defaultModel,
    models: [...provider.models],
  };
}

/** Keeps the preset choice of an unsaved draft in step with what the administrator already typed. */
export function withPreset(draft: ASRServiceDraft, preset: ASRPreset): ASRServiceDraft {
  return { ...draftFromPreset(preset), name: draft.name, apiKey: draft.apiKey, enabled: draft.enabled };
}

/** A same-machine deployment is reached at a host the server derives; only its port is entered. */
export function usesDerivedHost(draft: Pick<ASRServiceDraft, "scope">) {
  return draft.scope === "local_machine";
}

export function parsedPort(draft: Pick<ASRServiceDraft, "port">): number | null {
  const value = draft.port.trim();
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

export function portMissing(draft: ASRServiceDraft) {
  return usesDerivedHost(draft) && parsedPort(draft) === null;
}

/** A preset without a built-in address, or a deployment on another machine, needs an endpoint. */
export function endpointMissing(draft: ASRServiceDraft, preset: ASRPreset | undefined) {
  if (usesDerivedHost(draft) || draft.baseUrl.trim()) return false;
  return !preset?.defaultUrl;
}

/** The server drops the stored key and discovered models when the connection target changes. */
export function replacesConnection(draft: ASRServiceDraft) {
  if (!draft.id) return false;
  if (draft.scope !== draft.savedScope) return true;
  if (usesDerivedHost(draft)) return parsedPort(draft) !== (draft.savedPort ?? null);
  return draft.baseUrl.trim() !== draft.savedBaseUrl;
}

/** A service that refuses requests without a key needs one that survives the save. */
export function keyMissing(draft: ASRServiceDraft, preset: ASRPreset | undefined) {
  if (!preset?.keyRequired || draft.apiKey.trim()) return false;
  return !draft.hasApiKey || draft.clearKey || replacesConnection(draft);
}

export function updatePayload(draft: ASRServiceDraft): ASRProviderPayload {
  const derived = usesDerivedHost(draft);
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    enabledModels: draft.enabledModels,
    defaultModel: draft.defaultModel,
    boundary: draft.boundary,
    maxContentClass: draft.maxContentClass,
    ...(draft.scope ? { scope: draft.scope } : {}),
    ...(derived ? { port: parsedPort(draft) ?? 0 } : { baseUrl: draft.baseUrl.trim() }),
    ...(draft.clearKey ? { apiKey: "" } : draft.apiKey ? { apiKey: draft.apiKey } : {}),
  };
}

export function createPayload(draft: ASRServiceDraft): ASRProviderPayload {
  return { ...updatePayload(draft), presetId: draft.presetId };
}

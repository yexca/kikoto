import type { ContentMaximum, ContentClass, ContentAction } from "@/lib/contentPolicy";
import { deleteJSON, getJSON, getText, postJSONBody, putJSONBody } from "@/lib/apiTransport";

export type LLMModel = {
  id: string;
  name?: string;
  ownedBy?: string;
  contextSize?: number;
};

export type LLMProviderPreset = {
  id: string;
  name: string;
  kind: "openai" | "anthropic" | "ollama";
  defaultUrl: string;
  modelPath: string;
  boundary: "external" | "private";
  ollamaScope?: "local_machine";
};

export type LLMProvider = {
  id: string;
  presetId: string;
  name: string;
  kind: "openai" | "anthropic" | "ollama";
  baseUrl: string;
  boundary: "external" | "private";
  ollamaScope?: "local_machine" | "other_machine";
  maxContentClass: ContentMaximum;
  enabled: boolean;
  hasApiKey: boolean;
  defaultModel?: string;
  models: LLMModel[];
};

export type LLMProviderPayload = {
  id?: string;
  presetId: string;
  name: string;
  kind: LLMProvider["kind"];
  baseUrl?: string;
  apiKey?: string;
  boundary?: LLMProvider["boundary"];
  maxContentClass?: ContentMaximum;
  ollamaScope?: LLMProvider["ollamaScope"];
  enabled?: boolean;
  defaultModel?: string;
};

export type LLMProviderList = {
  providers: LLMProvider[];
  presets: LLMProviderPreset[];
  policy: LLMPolicy;
  /** Whether an administrator accepted the external service notice that LLM and ASR configuration requires. */
  noticeAccepted: boolean;
};

export type LLMKeywordRule = { id?: string; term: string; fields: string[]; action: ContentAction };
export type LLMPolicy = {
  alwaysScanAllAges: boolean;
  remoteLyrics?: boolean;
  tagRules: Array<{ tagId: number; action: ContentAction }>;
  keywords: LLMKeywordRule[];
};
export type LLMTranslationModel = Pick<LLMProvider, "id" | "name" | "defaultModel" | "boundary" | "maxContentClass">;
export type LLMAssessment = {
  class: ContentClass;
  reason: string;
  matches: Array<{ kind: string; rule: string; field?: string; action?: ContentAction }>;
};
export type LLMTranslation = {
  previewId: string;
  providerId: string;
  providerName: string;
  model: string;
  targetLanguage: string;
  assessment: LLMAssessment;
  source: { title?: string; description?: string; tags?: string[]; lyrics?: string[] };
  translation: { title?: string; description?: string; tags?: string[]; lyrics?: string[] };
};
export type LLMTranslationRequest = {
  providerId: string;
  targetLanguage: string;
  fields: string[];
  lyricsLocationId?: number;
  audioMediaItemId?: number;
  folderId?: number;
};
export type LLMReview = LLMTranslation & { status: string; fields: string[]; expiresAt: number };
export type LLMTranslationHistory = {
  current: { language: string; field: string; value: string; status: string }[];
  history: { id: number; language: string; field: string; action: string; createdAt: string }[];
};
export type LLMLyricsTranslationState =
  | "pending"
  | "requesting"
  | "failed"
  | "uncertain"
  | "invalid"
  | "cancelled"
  | "ready"
  | "expired"
  | "rejected"
  | "publishing"
  | "accepted";
/** A background translation of one lyrics file, with its review and publication. */
export type LLMLyricsTranslation = {
  taskId: number;
  runId: number;
  audioMediaItemId: number;
  lyricsLocationId: number;
  targetLanguage: string;
  providerName: string;
  model: string;
  state: LLMLyricsTranslationState;
  failureCode?: string;
  /** The preview to review while the translation awaits review or publication. */
  previewId?: string;
  updatedAt: string;
};

export const llmApi = {
  listTranslationModels: () => getJSON<LLMTranslationModel[]>("/api/llm/translation-models"),
  precheckWork: (id: number, payload: Partial<LLMTranslationRequest> = {}) =>
    postJSONBody<{ assessment: LLMAssessment; checkedFields: string[]; sentFields: string[] }>(
      `/api/works/${id}/llm-precheck`,
      payload,
    ),
  listTranslationReviews: (id: number) => getJSON<LLMReview[]>(`/api/works/${id}/llm-reviews`),
  listTranslations: (id: number) => getJSON<LLMTranslationHistory>(`/api/works/${id}/llm-translations`),
  restoreTranslation: (id: number, reviewId: number) =>
    postJSONBody<{ ok: boolean }>(`/api/works/${id}/llm-reviews/${reviewId}/restore`, {}),
  listLyricsTranslations: (id: number) => getJSON<LLMLyricsTranslation[]>(`/api/works/${id}/llm-lyrics-translations`),
  lyricsTranslationText: (id: number, preview: string) =>
    getText(`/api/works/${id}/llm-previews/${encodeURIComponent(preview)}/lyrics`),
  publishTranslatedLyrics: (asset: string) =>
    postJSONBody<{ ok: boolean }>(`/api/llm/lyrics-assets/${encodeURIComponent(asset)}/publish`, {}),
  queueTranslations: (workCodes: string[], payload: LLMTranslationRequest) =>
    postJSONBody<{ runs: { workId: number; runId: number; state: string; deduplicated: boolean }[] }>(
      "/api/llm/translation-runs",
      { workCodes, ...payload },
    ),
  resubmitUncertainTranslation: (runId: number) =>
    postJSONBody<{ runId: number; status: string }>(`/api/workflow-runs/${runId}/llm-resubmit`, {
      acknowledgeUncertain: true,
    }),
  rejectTranslation: (id: number, preview: string) =>
    deleteJSON<{ ok: boolean }>(`/api/works/${id}/llm-previews/${encodeURIComponent(preview)}`),
  revokeTranslation: (id: number, language: string, field: string) =>
    deleteJSON<{ ok: boolean }>(
      `/api/works/${id}/llm-translations/${encodeURIComponent(language)}/${encodeURIComponent(field)}`,
    ),
  listProviders: () => getJSON<LLMProviderList>("/api/llm/providers"),
  createProvider: (payload: LLMProviderPayload) => postJSONBody<LLMProvider>("/api/llm/providers", payload),
  updateProvider: (id: string, payload: Partial<LLMProviderPayload>) =>
    putJSONBody<LLMProvider>(`/api/llm/providers/${encodeURIComponent(id)}`, payload),
  deleteProvider: (id: string) => deleteJSON<{ ok: boolean }>(`/api/llm/providers/${encodeURIComponent(id)}`),
  fetchModels: (id: string) =>
    postJSONBody<LLMProvider>(`/api/llm/providers/${encodeURIComponent(id)}/fetch-models`, {}),
  acceptServiceNotice: () => postJSONBody<{ noticeAccepted: boolean }>("/api/llm/notice-acceptance", {}),
  updatePolicy: (policy: LLMPolicy) => putJSONBody<LLMPolicy>("/api/llm/policy", policy),
  translateWork: (id: number, payload: LLMTranslationRequest, signal?: AbortSignal) =>
    postJSONBody<LLMTranslation>(`/api/works/${id}/llm-translate`, payload, signal),
  applyTranslation: (id: number, previewId: string) =>
    putJSONBody<{ ok: boolean }>(`/api/works/${id}/llm-translation`, { previewId }),
};

import type { ContentMaximum, ContentClass, ContentAction } from "@/lib/contentPolicy";
import { deleteJSON, getJSON, postJSONBody, putJSONBody } from "@/lib/apiTransport";

export type LLMModel = {
  id: string;
  name?: string;
  ownedBy?: string;
  contextSize?: number;
};

export type LLMProviderKind = "openai" | "anthropic" | "ollama" | "kikoto-helper";

export type LLMScope = "local_machine" | "other_machine";

export type LLMProviderPreset = {
  id: string;
  name: string;
  kind: LLMProviderKind;
  defaultUrl: string;
  modelPath: string;
  boundary: "external" | "private";
  ollamaScope?: "local_machine";
  /** A local preset chooses between this server's machine, reached on a port, and another machine. */
  local?: boolean;
  /** The port a local preset suggests. */
  defaultPort?: number;
  /** The provider refuses every request without a key. */
  keyRequired?: boolean;
};

export type LLMProvider = {
  id: string;
  presetId: string;
  name: string;
  kind: LLMProviderKind;
  /** The origin requests go to; derived by the server for a same-machine provider. */
  baseUrl: string;
  boundary: "external" | "private";
  ollamaScope?: LLMScope;
  /** The location of a local preset. */
  scope?: LLMScope;
  /** The port of a local preset on this server's machine. */
  port?: number;
  maxContentClass: ContentMaximum;
  enabled: boolean;
  hasApiKey: boolean;
  /** The models offered for translation, in display order. */
  enabledModels: string[];
  /** One of the enabled models, or empty when none is enabled. */
  defaultModel?: string;
  /** Discovered models, offered as suggestions. */
  models: LLMModel[];
  /** The effective bound of one translation request, including the default. */
  requestTimeoutSeconds: number;
  /** Ollama's num_ctx; absent keeps the model default. */
  ollamaContextLength?: number;
  ollamaDisableThinking?: boolean;
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
  scope?: LLMScope;
  port?: number;
  enabled?: boolean;
  enabledModels?: string[];
  defaultModel?: string;
  /** Zero uses the server default. */
  requestTimeoutSeconds?: number;
  /** Zero keeps the model default. */
  ollamaContextLength?: number;
  ollamaDisableThinking?: boolean;
};

export type LLMProviderList = {
  providers: LLMProvider[];
  presets: LLMProviderPreset[];
  policy: LLMPolicy;
  /** Whether an administrator accepted the external service notice that LLM and ASR configuration requires. */
  noticeAccepted: boolean;
  /** The host a same-machine provider is reached at. */
  hostAddress: string;
};

export type LLMKeywordRule = { id: string; term: string; fields: string[]; action: ContentAction };
export type LLMPolicy = {
  alwaysScanAllAges: boolean;
  remoteLyrics?: boolean;
  llmTranslationTextOnly?: boolean;
  tagRules: Array<{ tagId: number; action: ContentAction }>;
  keywords: LLMKeywordRule[];
};
export type LLMTranslationModel = Pick<LLMProvider, "id" | "name" | "defaultModel" | "boundary" | "maxContentClass"> & {
  /** The enabled models, any of which a translation may use. */
  models: string[];
  /**
   * The target languages of each model limited to the directions its service
   * declares, from the requested work's original language. A model without an
   * entry translates any direction.
   */
  modelTargets?: Record<string, string[]>;
};
export type LLMAssessment = {
  class: ContentClass;
  reason: string;
  matches: Array<{ kind: string; rule: string; field?: string; action?: ContentAction }>;
  mode?: "translation_text";
  checkedFields?: string[];
  keywordRuleCount?: number;
};
export type LLMTranslationHistory = {
  current: { language: string; field: string; value: string; status: string }[];
  history: { id: number; language: string; field: string; action: string; createdAt: string }[];
};
export const llmApi = {
  /** With a work, each model's targets follow the language of the work's original edition. */
  listTranslationModels: (workId?: number) =>
    getJSON<LLMTranslationModel[]>(
      workId === undefined ? "/api/llm/translation-models" : `/api/llm/translation-models?workId=${workId}`,
    ),
  listTranslations: (id: number) => getJSON<LLMTranslationHistory>(`/api/works/${id}/llm-translations`),
  restoreTranslation: (id: number, reviewId: number) =>
    postJSONBody<{ ok: boolean }>(`/api/works/${id}/llm-reviews/${reviewId}/restore`, {}),
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
};

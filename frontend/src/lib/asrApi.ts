import { deleteJSON, getJSON, getText, postJSONBody, putJSONBody } from "@/lib/apiTransport";

export type ASRModel = { id: string; name?: string };

export type ASRScope = "local_machine" | "other_machine";

export type ASRPreset = {
  id: string;
  name: string;
  defaultUrl: string;
  boundary: "external" | "private";
  /** A local deployment chooses between this server's machine and another one. */
  local: boolean;
};

export type ASRProvider = {
  id: string;
  presetId: string;
  name: string;
  /** The origin requests go to; derived by the server for a same-machine deployment. */
  baseUrl: string;
  boundary: "external" | "private";
  allowSensitive: boolean;
  scope?: ASRScope;
  port?: number;
  enabled: boolean;
  hasApiKey: boolean;
  defaultModel: string;
  models: ASRModel[];
};

export type ASRProviderPayload = {
  presetId?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  boundary?: ASRProvider["boundary"];
  allowSensitive?: boolean;
  scope?: ASRScope;
  port?: number;
  enabled?: boolean;
  defaultModel?: string;
};

export type ASRProviderList = {
  providers: ASRProvider[];
  presets: ASRPreset[];
  /** The host a same-machine deployment is reached at. */
  hostAddress: string;
};

export type ASRService = Pick<ASRProvider, "id" | "name" | "defaultModel" | "boundary" | "allowSensitive">;

export type ASRTranscriptionState =
  "pending" | "requesting" | "failed" | "ready" | "publishing" | "accepted" | "rejected" | "cancelled";

export type ASRTranscription = {
  id: string;
  runId: number;
  audioMediaItemId: number;
  audioTitle: string;
  language: string;
  providerName: string;
  model: string;
  state: ASRTranscriptionState;
  failureCode?: string;
  progressMs: number;
  durationMs: number;
  createdAt: string;
};

export type ASRTranscriptionList = {
  transcriptions: ASRTranscription[];
  /** The lyrics language of the work's original edition, when known. */
  originLanguage: string;
};

export type ASRTranscriptionRequest = {
  audioMediaItemId: number;
  providerId: string;
  /** A lyrics language token, or empty to let the service detect it. */
  language: string;
};

export const asrApi = {
  listASRProviders: () => getJSON<ASRProviderList>("/api/asr/providers"),
  createASRProvider: (payload: ASRProviderPayload) => postJSONBody<ASRProvider>("/api/asr/providers", payload),
  updateASRProvider: (id: string, payload: ASRProviderPayload) =>
    putJSONBody<ASRProvider>(`/api/asr/providers/${encodeURIComponent(id)}`, payload),
  deleteASRProvider: (id: string) => deleteJSON<{ ok: boolean }>(`/api/asr/providers/${encodeURIComponent(id)}`),
  fetchASRModels: (id: string) =>
    postJSONBody<ASRProvider>(`/api/asr/providers/${encodeURIComponent(id)}/fetch-models`, {}),
  listASRServices: () => getJSON<ASRService[]>("/api/asr/services"),
  listASRTranscriptions: (workId: number) => getJSON<ASRTranscriptionList>(`/api/works/${workId}/asr-transcriptions`),
  createASRTranscription: (workId: number, payload: ASRTranscriptionRequest) =>
    postJSONBody<{ id: string; runId: number; state: ASRTranscriptionState; deduplicated: boolean }>(
      `/api/works/${workId}/asr-transcriptions`,
      payload,
    ),
  asrTranscriptionText: (id: string) => getText(`/api/asr/transcriptions/${encodeURIComponent(id)}/text`),
  acceptASRTranscription: (id: string) =>
    postJSONBody<{ ok: boolean }>(`/api/asr/transcriptions/${encodeURIComponent(id)}/accept`, {}),
  discardASRTranscription: (id: string) =>
    deleteJSON<{ ok: boolean }>(`/api/asr/transcriptions/${encodeURIComponent(id)}`),
};

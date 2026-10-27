import { getJSON, getText, postJSONBody, putJSONBody } from "@/lib/apiTransport";

/** The categories one Translate with AI request chooses; lyrics are listed track by track. */
export type TranslationCategory = "title" | "description" | "tags" | "files";

/** An item's category: one object a translation fills in. */
export type TranslationItemCategory = "title" | "description" | "tag" | "file_name" | "folder_name" | "lyrics";

export type TranslationItemState =
  | "queued"
  | "requesting"
  | "ready"
  | "accepted"
  | "rejected"
  | "failed"
  | "uncertain"
  | "invalid"
  | "policy_blocked"
  | "cancelled";

/** What one language lacks in one category. */
export type TranslationPlanCategory = {
  missing: number;
  active: number;
  characters: number;
  /** Active shared tag names another work's request queued. */
  otherWorks?: number;
  /** Works that show the missing shared tag names. */
  affectedWorks?: number;
  /** Names left out: nothing to translate, or too long. */
  skipped?: number;
};

export type TranslationPlanLanguage = {
  language: string;
  title: TranslationPlanCategory;
  description: TranslationPlanCategory;
  tags: TranslationPlanCategory;
  files: TranslationPlanCategory;
  /** Tracks whose lyrics in the language are being translated or wait for review. */
  lyrics: { audioMediaItemId: number; state: TranslationItemState }[];
};

export type TranslationPlan = {
  workId: number;
  originLanguage: string;
  permissions: { metadata: boolean; files: boolean; lyrics: boolean };
  languages: TranslationPlanLanguage[];
  attributionEnabled: boolean;
  /** Finished items apply through acceptance at once; off, they wait for review. */
  autoAccept: boolean;
};

export type TranslationLyricsTarget = {
  audioMediaItemId: number;
  targetLanguage: string;
  /** The lyrics file of the track to translate. */
  lyricsLocationId: number;
};

export type TranslationRequest = {
  languages: string[];
  categories: TranslationCategory[];
  providerId: string;
  model?: string;
  lyrics: TranslationLyricsTarget[];
};

export type TranslationSkip = { category: string; language?: string; subject?: string; reason: string };

export type TranslationItem = {
  id: number;
  runId: number;
  workId: number;
  workCode: string;
  workTitle: string;
  language: string;
  category: TranslationItemCategory;
  subject: string;
  state: TranslationItemState;
  failureCode?: string;
  /** A tag's source name, a file or folder path, or a track title. */
  label: string;
  source: string;
  result: string;
  model: string;
  sourceTitle?: string;
  /** The lyrics file an applied lyrics item became. */
  appliedPath?: string;
  progress: number;
  chunks: number;
  affectedWorks?: number;
  requestedBy: string;
  durationSeconds?: number;
  updatedAt: string;
};

export type TranslationItemView = "review" | "active" | "attention" | "history";

export type TranslationReviewResult = { id: number; ok: boolean; code?: string };

export type TranslationRunLanguage = {
  language: string;
  states: Partial<Record<TranslationItemState, number>>;
  total: number;
  chunksDone: number;
  chunks: number;
};

export type TranslationRun = {
  runId: number;
  status: string;
  /** The viewer may cancel this live run. */
  canCancel: boolean;
  workId: number;
  workCode: string;
  workTitle: string;
  requestedBy: string;
  createdAt: string;
  finishedAt?: string;
  languages: TranslationRunLanguage[];
};

export type TranslationRunView = "active" | "queued";

export type TranslationCenterCounts = { active: number; queued: number; review: number; attention: number };

export const translationApi = {
  translationPlan: (workId: number, languages: string[]) =>
    getJSON<TranslationPlan>(
      `/api/works/${workId}/ai-translation?languages=${languages.map(encodeURIComponent).join(",")}`,
    ),
  requestTranslation: (workId: number, request: TranslationRequest) =>
    postJSONBody<{ runId: number; items: number; skipped: TranslationSkip[] }>(
      `/api/works/${workId}/ai-translation`,
      request,
    ),
  listTranslationItems: (view: TranslationItemView, filter: { workId?: number; runId?: number } = {}) => {
    const query = new URLSearchParams({ view });
    if (filter.workId !== undefined) query.set("workId", String(filter.workId));
    if (filter.runId !== undefined) query.set("runId", String(filter.runId));
    return getJSON<{ items: TranslationItem[] }>(`/api/translation/items?${query}`);
  },
  translationItemText: (id: number, side: "source" | "result") =>
    getText(`/api/translation/items/${id}/text?side=${side}`),
  acceptTranslationItems: (ids: number[]) =>
    postJSONBody<{ results: TranslationReviewResult[] }>("/api/translation/items/accept", { ids }),
  rejectTranslationItems: (ids: number[]) =>
    postJSONBody<{ results: TranslationReviewResult[] }>("/api/translation/items/reject", { ids }),
  resendTranslationItems: (ids: number[], acknowledgeUncertain: boolean) =>
    postJSONBody<{ results: TranslationReviewResult[] }>("/api/translation/items/resend", {
      ids,
      acknowledgeUncertain,
    }),
  listTranslationRuns: (view: TranslationRunView) =>
    getJSON<{ runs: TranslationRun[]; counts: TranslationCenterCounts; autoAccept: boolean }>(
      `/api/translation/runs?view=${view}`,
    ),
  cancelTranslationRun: (id: number) =>
    postJSONBody<{ runId: number; status: string; message: string }>(`/api/translation/runs/${id}/cancel`, {}),
  lyricsAttribution: () => getJSON<{ enabled: boolean }>("/api/llm/lyrics-attribution"),
  updateLyricsAttribution: (enabled: boolean) =>
    putJSONBody<{ enabled: boolean }>("/api/llm/lyrics-attribution", { enabled }),
};

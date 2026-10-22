import { deleteJSON, getJSON, patchJSONBody, postJSON, postJSONBody, putJSONBody } from "@/lib/apiTransport";

/** A user-declared DLsite product whose metadata is stored on this work. */
export type WorkMetadataLink = {
  sourceCode: string;
  url: string;
  updatedAt: string;
};

export type WorkMetadataLinkResult = {
  link: WorkMetadataLink | null;
  sync?: WorkMetadataSyncRunResult;
};

/**
 * The parent product a purchase bonus belongs to. The bonus stays its own work;
 * `parentWork` is set while the library has a work in the parent's family.
 */
export type WorkPurchaseBonus = {
  status: "linked" | "unmatched" | "dismissed";
  parentCode?: string;
  origin: "detected" | "user";
  evidence?: string;
  url?: string;
  parentWork?: WorkPurchaseBonusWork | null;
  updatedAt: string;
};

export type WorkPurchaseBonusWork = {
  id: number;
  code: string;
  title: string;
};

/**
 * A work of an official bundle, by code. The code need not be a work; `work`
 * is set while the library has a work in its family.
 */
export type WorkBundleMember = {
  code: string;
  origin: "detected" | "user";
  url: string;
  work?: WorkPurchaseBonusWork | null;
};

/** A bundle that includes a work, by code. */
export type WorkBundleRef = {
  code: string;
  url: string;
  work?: WorkPurchaseBonusWork | null;
};

export type WorkBundleCandidates = {
  /** The title names a bundle, or the bundle already has members. */
  looksLikeBundle: boolean;
  seriesId: string;
  candidates: WorkBundleRef[];
};

export type WorkBundleMembersResult = {
  bundleMembers: WorkBundleMember[];
};

export type WorkPurchaseBonusResult = {
  purchaseBonus: WorkPurchaseBonus | null;
  sync?: WorkMetadataSyncRunResult;
};

export type WorkMetadataPresentation = {
  defaultVariantKey: string;
  variants: WorkMetadataVariant[];
};

export type WorkMetadataSyncStatus = {
  status: "not_synced" | "available" | "not_found" | "remote_fallback" | string;
  checkedAt: string;
  /** Remote source that filled a work DLsite reports as not found. */
  source?: string;
  /** Remote sources of normalized values while the work has no DLsite metadata. */
  fields?: WorkMetadataFieldSource[] | null;
};

export type WorkMetadataField = "title" | "release_date" | "age_rating" | "duration" | "circle" | "tags" | "cover";

export type WorkMetadataFieldSource = {
  field: WorkMetadataField | string;
  source: string;
};

export type WorkTitleChoice = {
  title: string;
  language: string;
  source: "manual" | "dlsite" | "original" | "remote" | "llm";
  /** Remote source display name when source is "remote". */
  sourceName?: string;
  code: string;
  description: string;
};

export type WorkMetadataVariant = {
  description?: string;
  titleSource?: WorkTitleChoice["source"];
  descriptionSource?: WorkTitleChoice["source"];
  key: string;
  language: string;
  title: string;
  tags: string[];
  origin: boolean;
};

export type ManualOverrideEntity = {
  name: string;
  externalId: string;
};

export type ManualOverrideSeries = {
  name: string;
  titleId: string;
  circleExternalId: string;
};

export type ManualOverridePerson = {
  name: string;
  personId: number;
};

export type ManualOverrideCover = {
  assetPath: string;
  originalPath: string;
  url: string;
};

export type WorkManualOverrides = {
  titles?: Record<string, string>;
  title?: string;
  description?: string;
  releaseDate?: string;
  ageRating?: string;
  circle?: ManualOverrideEntity;
  series?: ManualOverrideSeries;
  voiceActors?: ManualOverridePerson[];
  cover?: ManualOverrideCover;
};

export type WorkManualOverridePayload = {
  titles?: Record<string, string | null>;
  title?: string | null;
  description?: string | null;
  releaseDate?: string | null;
  ageRating?: string | null;
  circle?: ManualOverrideEntity | null;
  series?: ManualOverrideSeries | null;
  voiceActors?: ManualOverridePerson[];
};

export type MetadataTag = {
  pendingWorkCount: number;
  resolvedHidden: boolean;
  id: number;
  key: string;
  displayName: string;
  dlsiteGenreId: number | null;
  mergedIntoTagId: number | null;
  hidden: boolean;
  source: string;
  workCount: number;
  names: { language: string; name: string; source: string }[];
  mergedFromTagIds: number[];
};

export type MetadataTagOverride = { tagId: number; action: "add" | "remove" };

export type EffectiveMetadataTag = {
  id: number;
  displayName: string;
  source: string;
  /** Every known name, in the precedence order of `MetadataTag.names`; absent when the tag has none. */
  names?: MetadataTag["names"];
};

export type WorkMetadataTags = {
  tags: EffectiveMetadataTag[];
  inheritedTags: EffectiveMetadataTag[];
  overrides: MetadataTagOverride[];
};

export type MetadataCircle = {
  id: number;
  displayName: string;
  manualName: string;
  providerName: string;
  workCount: number;
  aliases: { id: number; alias: string; source: string }[];
  externalIds: string[];
  /** Primary DLsite maker id; empty for a circle known only from a remote source. */
  code: string;
  /** Latest known work's cover; present only in list results. */
  coverUrl?: string;
};

export type CircleMergeReview = {
  id: number;
  targetPartyId: number;
  sourcePartyId: number;
  targetName: string;
  sourceName: string;
  status: string;
  createdAt: string;
  undoneAt: string;
};

export type MetadataEntryPage<T> = { total: number; page: number; pageSize: number } & T;

export type WorkCoverCandidate = {
  locationId: number;
  fileName: string;
  path: string;
  previewUrl: string;
  sizeBytes: number | null;
  selected: boolean;
};

export type MetadataSuggestionResponse<T> = {
  items: T[];
  truncated: boolean;
};

export type CircleSuggestion = {
  partyId: number;
  name: string;
  externalId: string;
};

export type VoiceSuggestion = {
  personId: number;
  name: string;
};

export type SeriesSuggestion = {
  seriesId: number;
  name: string;
  titleId: string;
  circleExternalId: string;
  circleName: string;
};

export type MetadataIssueWork = {
  workId: number;
  primaryCode: string;
  title: string;
  providerCode: string;
  providerName: string;
  retrying: boolean;
  issues: {
    component: "metadata" | "cover";
    status: "failed" | "unavailable";
    failureCount: number;
    firstFailedAt: string;
    checkedAt: string;
  }[];
};

export type MetadataIssuePage = {
  items: MetadataIssueWork[];
  total: number;
  page: number;
  pageSize: number;
};

export type MetadataOnboarding = {
  status: string;
  missingWorks: number;
  runId: number;
};

export type WorkMetadataSyncRunResult = {
  runId: number;
  jobId: number;
  workId: number;
  primaryCode: string;
  status: string;
  deduplicated: boolean;
};

export type WorkMetadataPreviewFamilyEdition = {
  code: string;
  language: string;
  label: string;
  origin: boolean;
  available: boolean;
};

export type WorkMetadataPreviewTag = { id: number; name: string };

export type WorkMetadataPreviewValues = {
  title: string;
  titleLanguage: string;
  description: string;
  releaseDate: string | null;
  ageRating: string;
  series: string;
  rating: number | null;
  sales: number | null;
  regularPrice: number | null;
  price: number | null;
  priceCurrency: string;
  permanentlyFree: boolean | null;
  circle: string;
  circleExternalId: string;
  tags: string[];
  tagItems: WorkMetadataPreviewTag[];
  voiceActors: string[];
  coverAvailable: boolean;
  family: WorkMetadataPreviewFamilyEdition[];
};

export type WorkMetadataPreview = {
  previewId: string;
  workId: number;
  primaryCode: string;
  provider: string;
  sourceCode: string;
  sourceName: string;
  baseUpdatedAt: string;
  current: WorkMetadataPreviewValues;
  fetched: WorkMetadataPreviewValues;
};

export type WorkMetadataPreviewApply = {
  previewId: string;
  baseUpdatedAt: string;
  sourceId?: number;
  selections: Record<string, "current" | "fetched" | "manual" | "merged">;
  values: WorkMetadataPreviewValues;
  currentTags: WorkMetadataPreviewTag[];
  fetchedTags: WorkMetadataPreviewTag[];
};

export const metadataApi = {
  listMetadataTags: ({
    query = "",
    page = 1,
    pageSize = 25,
    includeHidden = false,
    resolveMerged = false,
    sort = "name",
    signal,
  }: {
    query?: string;
    page?: number;
    pageSize?: number;
    includeHidden?: boolean;
    resolveMerged?: boolean;
    /** "id" orders by tag id, independent of any language; "name" by display name. */
    sort?: "name" | "id";
    signal?: AbortSignal;
  } = {}) =>
    getJSON<MetadataEntryPage<{ tags: MetadataTag[]; pendingWorkCount?: number }>>(
      `/api/metadata/tags?q=${encodeURIComponent(query)}&page=${page}&pageSize=${pageSize}&includeHidden=${includeHidden}&resolveMerged=${resolveMerged}&sort=${sort}`,
      signal,
    ),
  createMetadataTag: (name: string) => postJSONBody<MetadataTag>("/api/metadata/tags", { name }),
  getMetadataTag: (id: number, signal?: AbortSignal) => getJSON<MetadataTag>(`/api/metadata/tags/${id}`, signal),
  updateMetadataTag: (id: number, payload: { names?: Record<string, string>; hidden?: boolean }) =>
    patchJSONBody<MetadataTag>(`/api/metadata/tags/${id}`, payload),
  mergeMetadataTag: (id: number, targetTagId: number) =>
    postJSONBody<MetadataTag>(`/api/metadata/tags/${id}/merge`, { targetTagId }),
  undoMetadataTagMerge: (id: number) => deleteJSON<MetadataTag>(`/api/metadata/tags/${id}/merge`),
  getWorkMetadataTags: (id: number, signal?: AbortSignal) =>
    getJSON<WorkMetadataTags>(`/api/works/${id}/metadata-tags`, signal),
  /** `newTagNames` holds language names for tags this save creates, keyed by the trimmed new tag name. */
  setWorkMetadataTags: (
    id: number,
    overrides: MetadataTagOverride[],
    newTags: string[] = [],
    newTagNames: Record<string, Record<string, string>> = {},
  ) =>
    putJSONBody<WorkMetadataTags>(`/api/works/${id}/metadata-tags`, {
      overrides,
      ...(newTags.length ? { newTags } : {}),
      ...(Object.keys(newTagNames).length ? { newTagNames } : {}),
    }),
  listMetadataCircles: ({
    query = "",
    page = 1,
    pageSize = 25,
    signal,
  }: { query?: string; page?: number; pageSize?: number; signal?: AbortSignal } = {}) =>
    getJSON<MetadataEntryPage<{ circles: MetadataCircle[] }>>(
      `/api/metadata/circles?q=${encodeURIComponent(query)}&page=${page}&pageSize=${pageSize}`,
      signal,
    ),
  getMetadataCircle: (id: number) => getJSON<MetadataCircle>(`/api/metadata/circles/${id}`),
  renameMetadataCircle: (id: number, manualName: string) =>
    patchJSONBody<MetadataCircle>(`/api/metadata/circles/${id}`, { manualName }),
  addCircleAlias: (id: number, alias: string) =>
    postJSONBody<MetadataCircle>(`/api/metadata/circles/${id}/aliases`, { alias }),
  deleteCircleAlias: (id: number, aliasId: number) =>
    deleteJSON<MetadataCircle>(`/api/metadata/circles/${id}/aliases/${aliasId}`),
  mergeMetadataCircle: (id: number, sourcePartyId: number) =>
    postJSONBody<{ ok: boolean; mergeId: number }>(`/api/metadata/circles/${id}/merge`, { sourcePartyId }),
  listCircleMerges: (id: number) => getJSON<CircleMergeReview[]>(`/api/metadata/circles/${id}/merges`),
  undoCircleMerge: (id: number, mergeId: number) =>
    postJSONBody<{ ok: boolean }>(`/api/metadata/circles/${id}/merges/${mergeId}/undo`, {}),
  getWorkManualOverrides: (id: number) => getJSON<WorkManualOverrides>(`/api/works/${id}/manual-overrides`),
  updateWorkManualOverrides: (id: number, payload: WorkManualOverridePayload) =>
    patchJSONBody<WorkManualOverrides>(`/api/works/${id}/manual-overrides`, payload),
  deleteWorkManualOverride: (id: number, field: string, language?: string) =>
    deleteJSON<{ ok: boolean; deleted: number }>(
      `/api/works/${id}/manual-overrides/${encodeURIComponent(field)}${language === undefined ? "" : `?language=${encodeURIComponent(language)}`}`,
    ),
  setWorkMetadataLink: (id: number, sourceCode: string) =>
    putJSONBody<WorkMetadataLinkResult>(`/api/works/${id}/metadata-link`, { sourceCode }),
  deleteWorkMetadataLink: (id: number) => deleteJSON<WorkMetadataLinkResult>(`/api/works/${id}/metadata-link`),
  setWorkPurchaseBonus: (id: number, parentCode: string) =>
    putJSONBody<WorkPurchaseBonusResult>(`/api/works/${id}/purchase-bonus`, { parentCode }),
  deleteWorkPurchaseBonus: (id: number) => deleteJSON<WorkPurchaseBonusResult>(`/api/works/${id}/purchase-bonus`),
  listWorkBundleCandidates: (id: number, signal?: AbortSignal) =>
    getJSON<WorkBundleCandidates>(`/api/works/${id}/bundle-candidates`, signal),
  addWorkBundleMember: (id: number, code: string) =>
    putJSONBody<WorkBundleMembersResult>(`/api/works/${id}/bundle-members/${encodeURIComponent(code)}`, {}),
  removeWorkBundleMember: (id: number, code: string) =>
    deleteJSON<WorkBundleMembersResult>(`/api/works/${id}/bundle-members/${encodeURIComponent(code)}`),
  listWorkCoverCandidates: (id: number) =>
    getJSON<{ candidates: WorkCoverCandidate[]; providerCoverUrl: string }>(`/api/works/${id}/cover-candidates`),
  setWorkCoverOverride: (id: number, locationId: number) =>
    postJSONBody<WorkManualOverrides>(`/api/works/${id}/cover-override`, { locationId }),
  suggestCircles: (query: string, limit = 20) =>
    getJSON<MetadataSuggestionResponse<CircleSuggestion>>(
      `/api/metadata-suggestions/circles?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  suggestVoices: (query: string, limit = 20) =>
    getJSON<MetadataSuggestionResponse<VoiceSuggestion>>(
      `/api/metadata-suggestions/voices?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  suggestSeries: (query: string, circleId = "", limit = 20) =>
    getJSON<MetadataSuggestionResponse<SeriesSuggestion>>(
      `/api/metadata-suggestions/series?q=${encodeURIComponent(query)}&limit=${limit}${circleId.trim() ? `&circleId=${encodeURIComponent(circleId.trim())}` : ""}`,
    ),
  syncWorkMetadata: (workId: number, sourceId?: number) =>
    sourceId === undefined
      ? postJSON<WorkMetadataSyncRunResult>(`/api/works/${workId}/metadata-sync`)
      : postJSONBody<WorkMetadataSyncRunResult>(`/api/works/${workId}/metadata-sync`, { sourceId }),
  previewWorkMetadata: (workId: number, sourceId?: number) =>
    sourceId === undefined
      ? postJSON<WorkMetadataPreview>(`/api/works/${workId}/metadata-preview`)
      : postJSONBody<WorkMetadataPreview>(`/api/works/${workId}/metadata-preview`, { sourceId }),
  applyWorkMetadataPreview: (workId: number, payload: WorkMetadataPreviewApply) =>
    postJSONBody<{ ok: boolean; updatedAt: string }>(`/api/works/${workId}/metadata-preview/apply`, payload),
  listMetadataIssues: (page: number, query: string, status: string, runId: number | null, signal?: AbortSignal) => {
    const params = new URLSearchParams({ page: String(page), q: query, status });
    if (runId) params.set("runId", String(runId));
    return getJSON<MetadataIssuePage>(`/api/metadata/issues?${params}`, signal);
  },
  retryMetadataIssues: (workIds: number[]) =>
    postJSONBody<{ queued: number; skipped: number; failed: number }>("/api/metadata/issues/retry", { workIds }),
  getMetadataOnboarding: (signal?: AbortSignal) => getJSON<MetadataOnboarding>("/api/metadata/onboarding", signal),
  startMetadataOnboarding: () => postJSONBody<MetadataOnboarding>("/api/metadata/onboarding/start", {}),
  dismissMetadataOnboarding: () => postJSONBody<MetadataOnboarding>("/api/metadata/onboarding/dismiss", {}),
};

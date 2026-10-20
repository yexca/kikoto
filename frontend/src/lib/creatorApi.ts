import { deleteJSON, getJSON, patchJSONBody, postJSON, postJSONBody, putJSONBody } from "@/lib/apiTransport";
import { normalizeCatalogSyncState, type CatalogSyncState } from "@/lib/catalogSyncState";
import type { ListeningStatus, UserTag, VoiceCredit, VoiceUserTag, WorkProgressSummary } from "@/lib/libraryApi";
import type { SourceAvailabilitySource } from "@/lib/remoteSourceApi";

export type CircleSourceStat = {
  key: string;
  sourceId?: number | null;
  displayName: string;
  status: string;
  count: number;
};

export type CreatorLatestWork = {
  primaryCode: string;
  title: string;
  releaseDate: string | null;
  coverUrl: string;
};

/** The cover a circle or voice actor shows. */
export type CreatorCover = {
  primaryCode: string;
  coverUrl: string;
  /** True for a work the user chose; false for the latest work's cover. */
  custom: boolean;
};

/** The personal state a user keeps on a circle or voice actor. */
export type CreatorUserStatePatch = {
  rating?: number | null;
  note?: string;
  favorite?: boolean;
  /** The work whose cover the creator shows; an empty code restores the latest work's cover. */
  coverPrimaryCode?: string;
};

/** The cover to show for a creator; a server that reports no cover shows the latest work's. */
export function creatorCoverUrl(creator: { cover?: CreatorCover | null; latestWork: CreatorLatestWork | null }) {
  return creator.cover?.coverUrl ?? creator.latestWork?.coverUrl ?? "";
}

export type CreatorListOptions = {
  page?: number;
  pageSize?: number;
  query?: string;
  filter?: string;
  tag?: string;
  /** "id" orders by Kikoto id; omitted keeps the browse order. */
  sort?: "id";
  signal?: AbortSignal;
};

export type CircleSummary = {
  id: number;
  externalId: string;
  displayName: string;
  aliases: string[];
  rating: number | null;
  note: string;
  favorite: boolean;
  userTags: VoiceUserTag[];
  localWorks: number;
  playableWorks: number;
  remoteWorks: number;
  missingWorks: number;
  catalogWorks: number;
  lastSyncedAt: string | null;
  syncState: CatalogSyncState;
  syncReason: string;
  sourceSummaries: CircleSourceStat[];
  latestWork: CreatorLatestWork | null;
  cover?: CreatorCover | null;
};

function normalizeCreatorSyncState<T extends { syncState?: unknown }>(creator: T): T & { syncState: CatalogSyncState } {
  return { ...creator, syncState: normalizeCatalogSyncState(creator.syncState) };
}

export type CircleSummaryPage = {
  circles: CircleSummary[];
  page: number;
  pageSize: number;
  total: number;
  catalogWorks: number;
  availableWorks: number;
};

export type CircleCatalogWork = {
  workId: number | null;
  primaryCode: string;
  remoteCode: string;
  title: string;
  releaseDate: string | null;
  updatedAt: string;
  coverUrl: string;
  dlsiteUrl: string;
  circle: string;
  circleExternalId: string;
  ageRating: string;
  tags: string[];
  userTags: UserTag[];
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  hasLyrics?: boolean;
  regularPrice: number | null;
  price: number | null;
  priceCurrency: string;
  permanentlyFree: boolean | null;
  series: string;
  seriesTitleId: string;
  catalogStatus: string;
  dlsiteAvailable: boolean;
  listeningMark: string;
  favorite: boolean;
  local: boolean;
  remote: boolean;
  sourceTags: CircleSourceStat[];
  progress?: WorkProgressSummary;
};

export type CircleWorksMeta = {
  page: number;
  pageSize: number;
  loaded: number;
  total: number;
  hasMore: boolean;
  truncated: boolean;
};

export type CircleSeries = {
  titleId: string;
  name: string;
  url: string;
  declaredWorks: number;
  works: number;
  localWorks: number;
  remoteWorks: number;
  missingWorks: number;
  workCodes: string[];
};

export type CircleDetail = CircleSummary & {
  availableWorks: number;
  works: CircleCatalogWork[];
  worksMeta: CircleWorksMeta;
  series: CircleSeries[];
  /** Newest follow run for this circle, so the page can follow a queued refresh across reloads. */
  refresh?: CreatorRefreshRun | null;
};

export type VoiceSummary = {
  personId: number;
  /** Addresses the voice detail page: the canonical DLsite voice actor id, or local-{personId}. */
  routeKey: string;
  displayName: string;
  aliases: string[];
  knownWorks: number;
  localWorks: number;
  remoteWorks: number;
  cachedWorks: number;
  playableWorks: number;
  lastSeenAt: string | null;
  lastSyncedAt: string | null;
  syncState: CatalogSyncState;
  syncReason: string;
  rating: number | null;
  note: string;
  favorite: boolean;
  userTags: VoiceUserTag[];
  sourceSummaries: CircleSourceStat[];
  latestWork: CreatorLatestWork | null;
  cover?: CreatorCover | null;
};

export type VoiceSummaryPage = {
  voices: VoiceSummary[];
  page: number;
  pageSize: number;
  total: number;
  tagOptions: string[];
};

export type VoiceAlias = {
  id: number;
  alias: string;
  source: string;
  createdAt: string;
};

export type VoiceAliasCandidate = {
  personId: number;
  displayName: string;
  aliases: VoiceAlias[];
  knownWorks: number;
  localWorks: number;
  remoteWorks: number;
};

export type VoiceMergeReview = {
  id: number;
  targetPersonId: number;
  sourcePersonId: number;
  targetName: string;
  sourceName: string;
  status: string;
  createdAt: string;
  undoneAt: string;
};

export type VoiceRemoteObservation = {
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  remoteCode: string;
  status: SourceAvailabilitySource["status"];
};

export type VoiceKnownWork = {
  workId: number;
  primaryCode: string;
  remoteCode: string;
  title: string;
  releaseDate: string | null;
  updatedAt: string;
  coverUrl: string;
  dlsiteUrl: string;
  circle: string;
  circleExternalId: string;
  ageRating: string;
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  hasLyrics?: boolean;
  regularPrice: number | null;
  price: number | null;
  priceCurrency: string;
  permanentlyFree: boolean | null;
  tags: string[];
  userTags: UserTag[];
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  series: string;
  seriesTitleId: string;
  listeningMark: ListeningStatus;
  favorite: boolean;
  local: boolean;
  remote: boolean;
  cache: boolean;
  sourceTags: CircleSourceStat[];
  remoteObservations?: VoiceRemoteObservation[];
  progress: WorkProgressSummary;
};

export type VoiceRemoteWork = {
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  remoteId: string;
  primaryCode: string;
  remoteCode: string;
  title: string;
  releaseDate: string;
  updatedAt: string;
  coverUrl: string;
  circle: string;
  ageRating: string;
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  hasLyrics?: boolean;
  price: number | null;
  tags: string[];
  voiceActors: string[];
  importStatus: string;
  remotePlayable: boolean;
  workId: number | null;
  hasLocal: boolean;
  hasCache: boolean;
  hasRemote: boolean;
  availability?: string;
};

/** One work of a voice actor: a known work, or a remote catalog work no local credit names. */
export type VoiceWork = (VoiceKnownWork | VoiceRemoteWork) & {
  remoteObservations?: VoiceRemoteObservation[];
};

export type VoiceWorksPage = {
  personId: number;
  works: VoiceWork[];
  page: number;
  pageSize: number;
  total: number;
};

export type VoiceWorksOptions = {
  page?: number;
  pageSize?: number;
  query?: string;
  /** all, available, local, remote, or missing; omitted keeps every work. */
  availability?: string;
  /** Omitted orders by newest release first. */
  sort?: string;
  direction?: "asc" | "desc";
  signal?: AbortSignal;
};

export type VoiceRemoteSourceSet = {
  sourceId: number;
  sourceCode: string;
  displayName: string;
  status: string;
  error: string;
  debugError?: string;
  elapsedMs: number;
  total: number;
  works: VoiceRemoteWork[];
};

export type VoiceCatalogSourceStatus = {
  sourceId: number;
  sourceCode: string;
  displayName: string;
  status: string;
  error: string;
  pages: number;
  total: number;
  matches: number;
  elapsedMs: number;
};

/**
 * A circle or voice actor detail refresh. It queues the creator's follow
 * workflow without a tag. A circle refresh syncs metadata for catalog works
 * that lack it; a voice actor refresh keeps to known works.
 */
export type CreatorRefreshRequest = {
  catalogRefresh: "stored" | "incremental" | "full";
  metadataRefresh: "off" | "missing" | "all";
  /** Circles only: also match the circle's works on every compatible remote source. */
  sourceCheck?: boolean;
};

export type CreatorRefreshRun = {
  runId: number;
  status: string;
  /** True when an identical refresh was already queued or running. */
  deduplicated?: boolean;
};

export type VoiceCatalogRefreshState = {
  status: string;
  reason: string;
  lastStatus: string;
  generation: number;
  runId?: number;
  lastAttemptAt: string;
  lastSuccessAt: string;
  complete: boolean;
  pagesFetched: number;
  catalogWorks: number;
  metadataQueued: number;
  queries: string[];
  sources: VoiceCatalogSourceStatus[];
  error: string;
};

export type VoiceDetail = VoiceSummary & {
  aliasRecords: VoiceAlias[];
  works: VoiceKnownWork[];
  remoteMatches: VoiceRemoteSourceSet[];
  /** Known works without a provider snapshot; Retry metadata targets exactly these. */
  metadataMissingWorks?: number;
};

function creatorListSearch(options: CreatorListOptions) {
  const search = new URLSearchParams();
  if (options.page) search.set("page", String(options.page));
  if (options.pageSize) search.set("pageSize", String(options.pageSize));
  if (options.query?.trim()) search.set("q", options.query.trim());
  if (options.filter && options.filter !== "all") search.set("filter", options.filter);
  if (options.tag?.trim()) search.set("tag", options.tag.trim());
  if (options.sort) search.set("sort", options.sort);
  const value = search.toString();
  return value ? `?${value}` : "";
}

export const creatorApi = {
  listCircles: async (options: CreatorListOptions = {}) => {
    const search = creatorListSearch(options);
    const page = await getJSON<CircleSummaryPage>(`/api/circles${search}`, options.signal);
    return { ...page, circles: page.circles.map(normalizeCreatorSyncState) };
  },
  getCircle: async (
    externalId: string,
    options:
      | {
          page?: number;
          pageSize?: number;
          query?: string;
          availability?: string;
          series?: string;
          /** Omitted orders by newest release first. */
          sort?: string;
          direction?: "asc" | "desc";
          signal?: AbortSignal;
        }
      | AbortSignal = {},
  ) => {
    const params = options instanceof AbortSignal ? {} : options;
    const signal = options instanceof AbortSignal ? options : params.signal;
    const search = new URLSearchParams();
    if (params.page !== undefined) search.set("page", String(params.page));
    if (params.pageSize !== undefined) search.set("pageSize", String(params.pageSize));
    if (params.query?.trim()) search.set("q", params.query.trim());
    if (params.availability && params.availability !== "all") search.set("availability", params.availability);
    if (params.series?.trim()) search.set("series", params.series.trim());
    if (params.sort && params.sort !== "release") search.set("sort", params.sort);
    if (params.direction === "asc") search.set("direction", "asc");
    const suffix = search.toString() ? `?${search.toString()}` : "";
    const detail = normalizeCreatorSyncState(
      await getJSON<CircleDetail>(`/api/circles/${encodeURIComponent(externalId)}${suffix}`, signal),
    );
    return {
      ...detail,
      worksMeta: detail.worksMeta ?? {
        page: params.page ?? 1,
        pageSize: params.pageSize ?? detail.works.length,
        loaded: detail.works.length,
        total: detail.catalogWorks,
        hasMore: detail.works.length < detail.catalogWorks,
        truncated: detail.works.length < detail.catalogWorks,
      },
    };
  },
  listVoices: async (options: CreatorListOptions = {}) => {
    const search = creatorListSearch(options);
    const page = await getJSON<VoiceSummaryPage>(`/api/voices${search}`, options.signal);
    return { ...page, voices: page.voices.map(normalizeCreatorSyncState) };
  },
  /** The person a voice detail route key addresses, with that person's canonical key. */
  resolveVoiceRoute: (routeKey: string, signal?: AbortSignal) =>
    getJSON<{ personId: number; routeKey: string }>(`/api/voice-routes/${encodeURIComponent(routeKey)}`, signal),
  getVoiceSummary: async (personId: number | string, signal?: AbortSignal) =>
    normalizeCreatorSyncState(
      await getJSON<VoiceDetail>(`/api/voices/${encodeURIComponent(String(personId))}?includeWorks=false`, signal),
    ),
  getVoiceWorks: (personId: number | string, options: VoiceWorksOptions = {}) => {
    const search = new URLSearchParams();
    if (options.page !== undefined) search.set("page", String(options.page));
    if (options.pageSize !== undefined) search.set("pageSize", String(options.pageSize));
    if (options.query?.trim()) search.set("q", options.query.trim());
    if (options.availability && options.availability !== "all") search.set("availability", options.availability);
    if (options.sort && options.sort !== "release") search.set("sort", options.sort);
    if (options.direction === "asc") search.set("direction", "asc");
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return getJSON<VoiceWorksPage>(
      `/api/voices/${encodeURIComponent(String(personId))}/works${suffix}`,
      options.signal,
    );
  },
  /** The remote sources' catalog state for a voice actor; their works are read with `getVoiceWorks`. */
  getVoiceRemoteMatches: (personId: number | string, signal?: AbortSignal) =>
    getJSON<{ personId: number; remoteMatches: VoiceRemoteSourceSet[]; refresh: VoiceCatalogRefreshState }>(
      `/api/voices/${encodeURIComponent(String(personId))}/remote-matches?includeWorks=false`,
      signal,
    ),
  refreshVoiceCatalog: (personId: number | string, payload: CreatorRefreshRequest) =>
    postJSONBody<VoiceCatalogRefreshState>(
      `/api/voices/${encodeURIComponent(String(personId))}/catalog/refresh`,
      payload,
    ),
  listVoiceAliasCandidates: (personId: number, query = "") =>
    getJSON<VoiceAliasCandidate[]>(
      `/api/voices/${personId}/alias-candidates${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`,
    ),
  createVoiceAlias: (personId: number, alias: string) =>
    postJSONBody<VoiceAlias[]>(`/api/voices/${personId}/aliases`, { alias }),
  deleteVoiceAlias: (personId: number, aliasId: number) =>
    deleteJSON<{ deleted: number; aliases: VoiceAlias[] }>(`/api/voices/${personId}/aliases/${aliasId}`),
  mergeVoiceAliasCandidate: (personId: number, sourcePersonId: number) =>
    postJSONBody<{
      mergeId: number;
      targetPersonId: number;
      sourcePersonId: number;
      targetName: string;
      mergedName: string;
    }>(`/api/voices/${personId}/merge`, { sourcePersonId }),
  listVoiceMergeReviews: (personId: number) => getJSON<VoiceMergeReview[]>(`/api/voices/${personId}/merges`),
  undoVoiceMerge: (personId: number, mergeId: number) =>
    postJSON<{ mergeId: number; targetPersonId: number; restoredPersonId: number; restoredName: string }>(
      `/api/voices/${personId}/merges/${mergeId}/undo`,
    ),
  updateVoiceUserState: async (personId: number, payload: CreatorUserStatePatch) =>
    normalizeCreatorSyncState(await patchJSONBody<VoiceSummary>(`/api/voices/${personId}/user-state`, payload)),
  setVoiceUserTags: (personId: number, tags: string[]) =>
    putJSONBody<{ personId: number; userTags: VoiceUserTag[] }>(`/api/voices/${personId}/tags`, { tags }),
  updateCircleUserState: async (externalId: string, payload: CreatorUserStatePatch) =>
    normalizeCreatorSyncState(
      await patchJSONBody<CircleSummary>(`/api/circles/${encodeURIComponent(externalId)}/user-state`, payload),
    ),
  setCircleUserTags: (externalId: string, tags: string[]) =>
    putJSONBody<{ externalId: string; userTags: VoiceUserTag[] }>(
      `/api/circles/${encodeURIComponent(externalId)}/tags`,
      { tags },
    ),
  refreshCircle: (externalId: string, payload: CreatorRefreshRequest) =>
    postJSONBody<CreatorRefreshRun>(`/api/circles/${encodeURIComponent(externalId)}/refresh`, payload),
  deleteCircleCatalogWork: (externalId: string, code: string) =>
    deleteJSON<{ ok: boolean; deleted: number }>(
      `/api/circles/${encodeURIComponent(externalId)}/catalog/${encodeURIComponent(code)}`,
    ),
};

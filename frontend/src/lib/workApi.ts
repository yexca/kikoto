import { getJSON, patchJSONBody, postJSONBody, putJSONBody, sharedGetJSON } from "@/lib/apiTransport";
import type {
  FavoriteList,
  ListeningStatus,
  SourcePresenceItem,
  UserTag,
  VoiceCredit,
  WorkProgressSummary,
} from "@/lib/libraryApi";
import type { LocalFolderAvailability } from "@/lib/localAvailability";
import type { MediaItem } from "@/lib/mediaApi";
import type {
  WorkManualOverrides,
  WorkMetadataLink,
  WorkMetadataPresentation,
  WorkMetadataSyncStatus,
  WorkBundleMember,
  WorkBundleRef,
  WorkPurchaseBonus,
  WorkPurchaseBonusWork,
  WorkTitleChoice,
} from "@/lib/metadataApi";

export type WorkPlaybackCursorResponse = {
  cursor: WorkProgressSummary | null;
};

export type StaffRole = "author" | "scenario" | "illustration" | "music" | "other";

/** One credited staff name; staff names are plain text, not voice actor people. */
export type StaffCredit = {
  role: StaffRole;
  name: string;
};

export type WorkDetail = {
  titleChoices?: Record<string, WorkTitleChoice>;
  id: number;
  primaryCode: string;
  baseCode: string;
  metadataLanguage: string;
  workType: string;
  title: string;
  titleKana: string;
  description: string;
  releaseDate: string | null;
  ageRating: string;
  /** The rating before a manual override, which may only fill it in or make it stricter. */
  providerAgeRating: string;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  coverUrl: string;
  dlsiteUrl: string;
  /** A work created from a folder without a work code: no provider metadata or remote sources. */
  customWork?: boolean;
  circle: string;
  circleExternalId: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  regularPrice: number | null;
  price: number | null;
  priceCurrency: string;
  permanentlyFree: boolean | null;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  dlsiteFetchedAt: string;
  tags: string[];
  userTags: UserTag[];
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  /** Non-voice credits from DLsite, in role order. */
  staffCredits?: StaffCredit[] | null;
  listeningStatus: ListeningStatus;
  favorite: boolean;
  /** The viewer's own one-to-five-star rating; null when unrated. */
  userRating: number | null;
  metadataPresentation: WorkMetadataPresentation;
  metadataSync: WorkMetadataSyncStatus;
  translations: WorkTranslation[];
  manualOverrides: WorkManualOverrides;
  llmDescriptions?: Record<string, string>;
  metadataLink?: WorkMetadataLink | null;
  /** Set when this work is a purchase bonus with a link decision. */
  purchaseBonus?: WorkPurchaseBonus | null;
  /** Linked purchase bonuses whose parent belongs to this work's family. */
  purchaseBonuses?: WorkPurchaseBonusWork[] | null;
  /** Members of the official bundle this work is, in the bundle's order. */
  bundleMembers?: WorkBundleMember[] | null;
  /** Official bundles that include this work. */
  includedInBundles?: WorkBundleRef[] | null;
  sourcePresence: SourcePresenceItem[] | null;
  localFolders: WorkFolderLocation[];
  mediaItems: MediaItem[];
};

export type WorkFolderLocation = {
  id: number;
  workId: number;
  fileSourceId: number;
  rootPath: string;
  role: string;
  state: "active" | "pending_cleanup" | "ignored" | string;
  /** "offline" while the folder's storage pool is offline. */
  availability: LocalFolderAvailability;
  primary: boolean;
};

export type WorkTranslation = {
  workId: number | null;
  primaryCode: string;
  title: string;
  metadataLanguage: string;
  editionLabel: string;
  origin: boolean;
  official: boolean;
  translationKind: "origin" | "official" | "community" | "third_party" | "unknown";
  current: boolean;
  hasMedia: boolean;
  mediaState: "metadata_only" | "present_unindexed" | "indexed_available" | "unavailable";
  localAvailable: boolean;
};

export type WorkResolveResponse = {
  requestedCode: string;
  resolvedCode: string;
  workId: number;
  baseCode: string;
  isTranslation: boolean;
  title: string;
  coverUrl: string;
  circle: string;
  circleExternalId: string;
  releaseDate: string | null;
  rating: number | null;
  sales: number | null;
  regularPrice: number | null;
  price: number | null;
  priceCurrency: string;
  permanentlyFree: boolean | null;
  tags: string[];
  voiceActors: string[];
};

export type WorkEntityLink = {
  kind: "circle" | "series" | "voice";
  route: string;
  resolved: boolean;
  fetched: boolean;
};

export type LocalMediaRefreshResult = {
  workId: number;
  fileSourceId: number;
  /** The folder refreshed, when the request named one. */
  folderId?: number;
  status: string;
  /** Available local files indexed: in the folder when one was named, otherwise on the source. */
  indexedFiles: number;
};

export const workApi = {
  getWorkPlaybackCursor: (id: number, signal?: AbortSignal) =>
    getJSON<WorkPlaybackCursorResponse>(`/api/works/${id}/playback-cursor`, signal),
  // Components that mount together often ask for the same work; they share one
  // in-flight request, and nothing is cached once it settles.
  getWork: (id: number, signal?: AbortSignal) => sharedGetJSON<WorkDetail>(`/api/works/${id}`, signal),
  getWorkSummary: (id: number | string, signal?: AbortSignal) =>
    getJSON<WorkDetail>(`/api/works/${encodeURIComponent(id)}?includeMedia=false`, signal),
  getWorkMedia: (id: number | string, signal?: AbortSignal) =>
    getJSON<{ workId: number; mediaWorkId: number; mediaItems: MediaItem[] }>(
      `/api/works/${encodeURIComponent(id)}/media`,
      signal,
    ),
  /** Indexes a work's local files again: one folder when `folderId` is given, otherwise its folders on the source. */
  refreshWorkLocalFiles: (id: number, fileSourceId?: number | null, folderId?: number) =>
    postJSONBody<LocalMediaRefreshResult>(`/api/works/${id}/local-files/refresh`, {
      fileSourceId: fileSourceId ?? 0,
      ...(folderId ? { folderId } : {}),
    }),
  resolveWorkCode: (code: string, signal?: AbortSignal) =>
    getJSON<WorkResolveResponse>(`/api/works/${encodeURIComponent(code)}/resolve`, signal),
  resolveWorkEntityLink: (code: string, kind: WorkEntityLink["kind"], name = "") =>
    postJSONBody<WorkEntityLink>(`/api/works/${encodeURIComponent(code)}/entity-links/resolve`, { kind, name }),
  /** Read-only lookup of persisted relationships; Demo uses it because the resolver may sync metadata. */
  lookupWorkEntityLink: (code: string, kind: WorkEntityLink["kind"], name = "") =>
    getJSON<WorkEntityLink>(
      `/api/works/${encodeURIComponent(code)}/entity-links?${new URLSearchParams({ kind, name })}`,
    ),
  getWorkFavoriteLists: (id: number) => getJSON<FavoriteList[]>(`/api/works/${id}/favorite-lists`),
  setWorkFavoriteLists: (id: number, listIds: number[]) =>
    putJSONBody<{ workId: number; favorite: boolean; lists: FavoriteList[] }>(`/api/works/${id}/favorite-lists`, {
      listIds,
    }),
  setWorkUserTags: (id: number, tags: string[]) =>
    putJSONBody<{ workId: number; userTags: UserTag[] }>(`/api/works/${id}/tags`, { tags }),
  /** userRating null clears the rating; leaving it out keeps it. */
  updateWorkUserState: (id: number, payload: { listeningStatus?: ListeningStatus; userRating?: number | null }) =>
    patchJSONBody<{ workId: number; listeningStatus: ListeningStatus; favorite: boolean; userRating: number | null }>(
      `/api/works/${id}/user-state`,
      payload,
    ),
};

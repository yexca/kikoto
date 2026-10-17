import { api, ApiError, type LibrarySource, type RemoteTrack, type RemoteWorkDetail, type WorkDetail } from "@/lib/api";
import {
  type RemoteSourceAvailability,
  remoteSourceTabKey,
  type SourceTabInfo,
} from "@/features/work-detail/source/sourceContextModel";
import type { UnifiedWorkDetailPresentation } from "@/features/work-detail/WorkDetailLayout";
import { dlsiteWorkURL, type RemoteWorkPreview } from "@/features/work-detail/workDetailShared";
import { type TreeNode, treeStats, type TreeStats } from "@/features/work-detail/media/mediaTreeModel";
import i18n from "@/i18n";
import {
  type ActiveSourceInfoModel,
  emptyRemoteWorkPreview,
  remoteDetailActionCode,
  trackedPresenceForRemoteSource,
} from "@/features/work-detail/workDetailHelpers";
import { resolveMetadataVariant } from "@/features/work-detail/metadataPresentationModel";

export function remoteOnlySourceInfo(
  displaySourceName: string,
  tabs: SourceTabInfo[],
  activeKey: string,
  stats: TreeStats,
  primaryRemoteSelected: boolean,
  message: string,
  treeError: string,
  isDetailLoading: boolean,
  treeLoading: boolean,
  detail: RemoteWorkDetail | null,
): ActiveSourceInfoModel {
  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const activeSource = activeTab
    ? { kind: activeTab.kind, status: activeTab.status, statusLabel: activeTab.statusLabel }
    : { kind: "remote" as const, status: "degraded" as const, statusLabel: i18n.t("libraryDetail.loadingSource") };
  return {
    label: displaySourceName,
    ...activeSource,
    stats,
    loading: remoteOnlyDirectoryLoading({
      primaryRemoteSelected,
      message,
      treeError,
      isDetailLoading,
      treeLoading,
    }),
    metadataDurationSeconds: detail ? detail.durationSeconds : null,
  };
}

function remoteOnlyTranslations(editions: RemoteWorkDetail["languageEditions"]): WorkDetail["translations"] {
  return editions.map((edition) => ({
    workId: null,
    primaryCode: edition.remoteCode,
    title: edition.label,
    metadataLanguage: edition.language,
    editionLabel: edition.label,
    origin: edition.origin,
    official: !edition.origin,
    translationKind: edition.origin ? "origin" : "official",
    current: edition.current,
    hasMedia: true,
    mediaState: "indexed_available",
    localAvailable: false,
  }));
}

type RemoteOnlyPresentationIdentity = {
  coverUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  releaseDate: string;
  ageRating: string;
  voiceActors: string[];
  tags: string[];
};

function remoteOnlyPreviewIdentity(preview: RemoteWorkPreview | null, code: string): RemoteOnlyPresentationIdentity {
  const fallback = preview ?? emptyRemoteWorkPreview;
  return {
    coverUrl: fallback.coverUrl,
    title: preview ? fallback.title : code,
    circle: fallback.circle,
    circleExternalId: fallback.circleExternalId,
    rating: fallback.rating,
    ratingCount: null,
    sales: fallback.sales,
    releaseDate: fallback.releaseDate || i18n.t("libraryDetail.unknownReleaseDate"),
    ageRating: fallback.ageRating,
    voiceActors: fallback.voiceActors,
    tags: fallback.tags,
  };
}

function remoteOnlyPresentationIdentity(
  remoteIdentity: RemoteWorkDetail | null,
  preview: RemoteWorkPreview | null,
  code: string,
): RemoteOnlyPresentationIdentity {
  const fallback = remoteOnlyPreviewIdentity(preview, code);
  if (!remoteIdentity) return fallback;
  return {
    coverUrl: remoteIdentity.coverUrl,
    title: remoteIdentity.title,
    circle: remoteIdentity.circle,
    circleExternalId: remoteIdentity.circleRef?.externalId ?? fallback.circleExternalId,
    rating: remoteIdentity.rating ?? fallback.rating,
    ratingCount: remoteIdentity.ratingCount ?? null,
    sales: remoteIdentity.sales ?? fallback.sales,
    releaseDate: remoteIdentity.releaseDate || fallback.releaseDate,
    ageRating: remoteIdentity.ageRating,
    voiceActors: remoteIdentity.voiceActors,
    tags: remoteIdentity.tags,
  };
}

function remoteOnlyPresentationMetadata(
  remoteIdentity: RemoteWorkDetail | null,
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>,
  identity: RemoteOnlyPresentationIdentity,
) {
  const editions = remoteIdentity ? remoteIdentity.languageEditions : [];
  const origin = editions.find((edition) => edition.origin);
  const current = editions.find((edition) => edition.current);
  return {
    title: activeMetadataVariant ? activeMetadataVariant.title : identity.title,
    tags: activeMetadataVariant ? activeMetadataVariant.tags : identity.tags,
    baseCode: origin ? origin.remoteCode : "",
    language: activeMetadataVariant ? activeMetadataVariant.language : current ? current.language : "",
    presentation: remoteIdentity ? remoteIdentity.metadataPresentation : undefined,
    activeVariantKey: activeMetadataVariant ? activeMetadataVariant.key : "",
    translations: remoteOnlyTranslations(editions),
  };
}

function remoteOnlyPresentationCode(
  displayPrimaryCode: string,
  remoteIdentity: RemoteWorkDetail | null,
  preview: RemoteWorkPreview | null,
  code: string,
) {
  const fallback = preview ?? emptyRemoteWorkPreview;
  return displayPrimaryCode || remoteIdentity?.remoteId || fallback.remoteId || code;
}

export function remoteOnlyWorkDetailPresentation({
  remoteIdentity,
  detail,
  preview,
  code,
  displayPrimaryCode,
  displayRemoteCode,
  activeMetadataVariant,
  sourceInfo,
  loading,
  onMetadataVariantSelect,
  onVersionSelect,
}: {
  remoteIdentity: RemoteWorkDetail | null;
  detail: RemoteWorkDetail | null;
  preview: RemoteWorkPreview | null;
  code: string;
  displayPrimaryCode: string;
  displayRemoteCode: string;
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>;
  sourceInfo: ActiveSourceInfoModel;
  loading: boolean;
  onMetadataVariantSelect: (key: string) => void;
  onVersionSelect: (code: string) => void;
}): UnifiedWorkDetailPresentation {
  const identity = remoteOnlyPresentationIdentity(remoteIdentity, preview, code);
  const metadata = remoteOnlyPresentationMetadata(remoteIdentity, activeMetadataVariant, identity);
  const presentationCode = remoteOnlyPresentationCode(displayPrimaryCode, remoteIdentity, preview, code);
  return {
    coverUrl: identity.coverUrl,
    fallbackCode: presentationCode,
    code: presentationCode,
    dlsiteUrl: detail ? dlsiteWorkURL(detail.primaryCode) : "",
    title: metadata.title,
    circle: identity.circle,
    circleExternalId: identity.circleExternalId,
    series: "",
    seriesTitleId: "",
    seriesCircleExternalId: "",
    ratingLabel: i18n.t("libraryDetail.rating"),
    rating: identity.rating,
    ratingCount: identity.ratingCount,
    sales: identity.sales,
    baseCode: metadata.baseCode,
    metadataLanguage: metadata.language,
    metadataPresentation: metadata.presentation,
    activeMetadataVariantKey: metadata.activeVariantKey,
    onMetadataVariantSelect,
    translations: metadata.translations,
    activeVersionCode: displayRemoteCode,
    onVersionSelect: (translation) => onVersionSelect(translation.primaryCode),
    remoteVersions: true,
    dlsiteFetchedAt: "",
    releaseDate: identity.releaseDate,
    ageRating: identity.ageRating,
    sourceInfo,
    voiceActors: identity.voiceActors,
    voiceCredits: [],
    tags: metadata.tags,
    loading,
  };
}

export function remoteOnlyDisplayState(
  identityDetail: RemoteWorkDetail | null,
  detail: RemoteWorkDetail | null,
  preview: RemoteWorkPreview | null,
  source: LibrarySource,
  code: string,
  selectedMetadataVariantKey: string,
) {
  const remoteIdentity = identityDetail ?? detail;
  return {
    remoteIdentity,
    activeMetadataVariant: resolveMetadataVariant(remoteIdentity?.metadataPresentation, selectedMetadataVariantKey),
    displaySourceName: remoteIdentity?.sourceName ?? source.displayName,
    displayPrimaryCode: remoteIdentity?.primaryCode || preview?.primaryCode || code,
    displayRemoteCode: detail ? remoteDetailActionCode(detail) : preview?.remoteCode || preview?.primaryCode || code,
  };
}

export function remoteOnlyActiveSourceState(
  sourceID: number,
  activeKey: string,
  tabs: SourceTabInfo[],
  availability: RemoteSourceAvailability[],
) {
  const primaryRemoteSelected = activeKey === remoteSourceTabKey(sourceID);
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;
  const activeTrackedPresence = activeTab?.kind === "tracked" ? (activeTab.presence ?? null) : null;
  return {
    primaryRemoteSelected,
    activeTab,
    activeTrackedPresence,
    activeTrackedForked: Boolean(activeTrackedPresence && activeTab?.status === "available"),
    activeRemoteAvailability: availability.find((item) => remoteSourceTabKey(item.source.id) === activeKey) ?? null,
    primaryRemoteAvailability: availability.find((item) => item.source.id === sourceID) ?? null,
  };
}

export function remoteOnlyMaterializedState({
  trackedWork,
  sourceID,
  displayRemoteCode,
  primaryRemoteAvailability,
  detail,
  primaryRemoteSelected,
  remoteTree,
  materializedTree,
  remoteStats,
}: {
  trackedWork: WorkDetail | null;
  sourceID: number;
  displayRemoteCode: string;
  primaryRemoteAvailability: RemoteSourceAvailability | null;
  detail: RemoteWorkDetail | null;
  primaryRemoteSelected: boolean;
  remoteTree: TreeNode;
  materializedTree: TreeNode;
  remoteStats: TreeStats;
}) {
  const trackedSourcePresence = trackedPresenceForRemoteSource(trackedWork, sourceID, displayRemoteCode);
  const visibleTree = primaryRemoteSelected ? remoteTree : materializedTree;
  return {
    hasTrackedSource: Boolean(trackedSourcePresence || primaryRemoteAvailability?.summary.hasTracked),
    materializedWorkID: trackedWork?.id ?? primaryRemoteAvailability?.summary.workId ?? detail?.workId ?? null,
    visibleTree,
    visibleDirectoryStats: primaryRemoteSelected ? remoteStats : treeStats(visibleTree),
  };
}

type RemoteOnlyDetailLoadOutcome =
  { kind: "loaded" } | { kind: "not_found" } | { kind: "failed"; message: string } | { kind: "cancelled" };

function remoteOnlyLoadCancelled(error: unknown, timedOut: boolean) {
  return error instanceof DOMException && error.name === "AbortError" && !timedOut;
}

function remoteOnlyTreeErrorMessage(error: unknown, timedOut: boolean) {
  if (timedOut) return i18n.t("libraryDetail.remoteDirectoryTimedOut");
  return error instanceof Error ? error.message : i18n.t("libraryDetail.remoteDirectoryFailed");
}

function remoteOnlyDetailErrorOutcome(error: unknown, timedOut: boolean): RemoteOnlyDetailLoadOutcome {
  if (remoteOnlyLoadCancelled(error, timedOut)) return { kind: "cancelled" };
  if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
  return {
    kind: "failed",
    message: timedOut
      ? i18n.t("libraryDetail.remotePreviewTimedOut")
      : error instanceof Error
        ? error.message
        : i18n.t("libraryDetail.remotePreviewFailed"),
  };
}

export async function loadRemoteOnlyDetail({
  sourceID,
  code,
  signal,
  didTimeOut,
  onMetadata,
  onTracks,
  onTreeError,
}: {
  sourceID: number;
  code: string;
  signal: AbortSignal;
  didTimeOut: () => boolean;
  onMetadata: (detail: RemoteWorkDetail) => void;
  onTracks: (tracks: RemoteTrack[]) => void;
  onTreeError: (message: string) => void;
}): Promise<RemoteOnlyDetailLoadOutcome> {
  try {
    const metadata = await api.getRemoteSourceWorkMetadata(sourceID, code, signal);
    if (signal.aborted) return { kind: "cancelled" };
    onMetadata({ ...metadata, tracks: [] });
    try {
      const tracks = await api.getRemoteSourceWorkTracks(sourceID, metadata.remoteCode || code, signal);
      if (!signal.aborted) onTracks(tracks.tracks);
    } catch (error) {
      const timedOut = didTimeOut();
      if (remoteOnlyLoadCancelled(error, timedOut)) return { kind: "cancelled" };
      onTreeError(remoteOnlyTreeErrorMessage(error, timedOut));
    }
    return { kind: "loaded" };
  } catch (error) {
    return remoteOnlyDetailErrorOutcome(error, didTimeOut());
  }
}

/** Whether the primary remote directory is still loading with nothing to show yet. */
export function remoteOnlyDirectoryLoading(state: {
  primaryRemoteSelected: boolean;
  message: string;
  treeError: string;
  isDetailLoading: boolean;
  treeLoading: boolean;
}) {
  return (
    state.primaryRemoteSelected && !state.message && !state.treeError && (state.isDetailLoading || state.treeLoading)
  );
}

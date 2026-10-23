// Pure derivations for the persisted work detail: which source context is
// active, what the directory shows, and the page presentation props.

import type { ReactNode } from "react";

import {
  type RemoteSourceAvailability,
  remoteSourceCanBrowse,
  type SourceTabInfo,
} from "@/features/work-detail/source/sourceContextModel";
import type {
  MediaItem,
  RemoteWorkDetail,
  SourcePresenceItem,
  VoiceCredit,
  WorkDetail,
  WorkMetadataPresentation,
  WorkMetadataSyncStatus,
  WorkProgressSummary,
} from "@/lib/api";
import { sourcePresenceActionCode } from "@/features/work-detail/workDetailShared";
import { buildRemoteTree, buildTree, emptyTree, type TreeStats } from "@/features/work-detail/media/mediaTreeModel";
import i18n from "@/i18n";
import { type ActiveSourceInfoModel, trackedPresenceForRemoteSource } from "@/features/work-detail/workDetailHelpers";
import type { DetailActionMode } from "@/features/work-detail/WorkDetailActionBars";
import type { detailHeroModel, UnifiedWorkDetailPresentation } from "@/features/work-detail/WorkDetailLayout";
import { mergeRemoteWorkVersions } from "@/features/work-detail/workVersionModel";
import type { resolveMetadataVariant } from "@/features/work-detail/metadataPresentationModel";

export function persistedFetchTarget(
  selectedRemoteSource: RemoteSourceAvailability | null | undefined,
  selectedTrackedRemoteSource: RemoteSourceAvailability | null | undefined,
  selectedRemoteWorkCode: string,
  selectedTrackedPresence: SourcePresenceItem | null,
  work: WorkDetail | null,
  code: string,
) {
  const remote = selectedRemoteSource ?? selectedTrackedRemoteSource ?? undefined;
  if (selectedRemoteSource) return { remote, code: selectedRemoteWorkCode };
  if (selectedTrackedPresence) {
    return { remote, code: sourcePresenceActionCode(selectedTrackedPresence, work?.primaryCode ?? code) };
  }
  return { remote, code: work?.primaryCode ?? code };
}

export function hasResumablePlaybackCursor(cursor: WorkProgressSummary | null) {
  return Boolean(cursor && !cursor.completed && Number.isFinite(cursor.positionSeconds) && cursor.positionSeconds > 0);
}

/** The active folders of the shown edition on one local source. */
export function activeLocalFolders(work: WorkDetail | null, fileSourceId: number | null | undefined) {
  if (!work || !fileSourceId) return [];
  return (work.localFolders ?? []).filter(
    (folder) =>
      folder.workId === work.id &&
      folder.fileSourceId === fileSourceId &&
      folder.state === "active" &&
      folder.rootPath.trim() !== "",
  );
}

/**
 * The media items that have a local file inside one work folder, with only
 * that folder's local locations. Files at the same path in two folders of a
 * work are one media item, so its locations in the other folders are dropped.
 */
export function mediaItemsInLocalFolder(items: MediaItem[], rootPath: string) {
  const root = rootPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!root) return items;
  const insideRoot = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "").startsWith(`${root}/`);
  return items.flatMap((item) => {
    const locations = item.locations.filter(
      (location) => location.locationType !== "local" || insideRoot(location.path),
    );
    return locations.some((location) => location.locationType === "local") ? [{ ...item, locations }] : [];
  });
}

export function persistedMediaTreeInput({
  mediaLoading,
  localDirectoryWork,
  work,
  selectedTrackedForked,
  selectedTrackedSourceID,
  selectedSource,
  selectedRemoteSource,
  selectedRemoteSourceID,
  selectedRemoteDetail,
  selectedTrackedPresence,
}: {
  mediaLoading: boolean;
  localDirectoryWork: WorkDetail | null;
  work: WorkDetail | null;
  selectedTrackedForked: boolean;
  selectedTrackedSourceID: number | null;
  selectedSource: SourceTabInfo | null | undefined;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteSourceID: number | null;
  selectedRemoteDetail: RemoteWorkDetail | null;
  selectedTrackedPresence: SourcePresenceItem | null;
}) {
  return {
    mediaLoading,
    localItems: localDirectoryWork?.mediaItems ?? [],
    localCode: localDirectoryWork?.primaryCode ?? work?.primaryCode ?? "",
    fileSourceId: selectedTrackedForked ? selectedTrackedSourceID : (selectedSource?.fileSourceId ?? null),
    selectionKey: `${selectedSource?.key ?? ""}:${selectedTrackedSourceID ?? selectedRemoteSourceID ?? 0}`,
    remoteSelected: Boolean(selectedRemoteSource),
    remoteDetail: selectedRemoteDetail,
    trackedUnavailable: Boolean(selectedTrackedPresence && !selectedTrackedForked),
    emptyTree,
    buildLocalTree: buildTree,
    buildRemoteTree,
  };
}

export function persistedDirectoryDescription({
  selectedTrackedPresence,
  selectedTrackedForked,
  selectedSource,
  selectedRemoteSource,
  workHasNoLinkedSource,
}: {
  selectedTrackedPresence: SourcePresenceItem | null;
  selectedTrackedForked: boolean;
  selectedSource: SourceTabInfo | null | undefined;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  workHasNoLinkedSource: boolean;
}) {
  if (selectedTrackedPresence) {
    if (selectedTrackedForked) {
      const sourceName =
        selectedTrackedPresence.fileSourceName ||
        selectedTrackedPresence.fileSourceCode ||
        i18n.t("libraryDetail.sourceInfo");
      return i18n.t("libraryDetail.browsingTrackedFork", { source: sourceName });
    }
    const sourceName =
      selectedTrackedPresence.fileSourceName ||
      selectedTrackedPresence.fileSourceCode ||
      i18n.t("libraryDetail.sourceInfo");
    return i18n.t("libraryDetail.trackedSourceUnforkedDescription", { source: sourceName });
  }
  if (selectedSource?.kind === "tracked") {
    return i18n.t("libraryDetail.workNotTrackedDescription");
  }
  if (selectedRemoteSource) {
    return i18n.t("libraryDetail.remoteFilesPreviewShort", { source: selectedRemoteSource.source.displayName });
  }
  if (workHasNoLinkedSource) {
    return i18n.t("libraryDetail.noLinkedSourceDescription");
  }
  return i18n.t("libraryDetail.fileLocationsGrouped");
}

export function persistedDetailActionMode(
  selectedRemoteSource: RemoteSourceAvailability | null | undefined,
  selectedTrackedPresence: SourcePresenceItem | null,
  selectedTrackedForked: boolean,
  selectedSource: SourceTabInfo | null | undefined,
): DetailActionMode {
  if (selectedRemoteSource) return "remote_source";
  if (selectedTrackedPresence) return selectedTrackedForked ? "tracked_forked" : "tracked_unforked";
  return selectedSource?.kind === "tracked" ? "tracked_unforked" : "local";
}

export function persistedTrackingActionState({
  work,
  selectedRemoteSource,
  selectedRemoteWorkCode,
  selectedTrackedPresence,
}: {
  work: WorkDetail | null;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteWorkCode: string;
  selectedTrackedPresence: SourcePresenceItem | null;
}) {
  const selectedRemoteTrackedPresence = selectedRemoteSource
    ? trackedPresenceForRemoteSource(work, selectedRemoteSource.source.id, selectedRemoteWorkCode)
    : null;
  const activeTrackedPresence = selectedTrackedPresence ?? selectedRemoteTrackedPresence;
  const selectedRemoteHasTracked = Boolean(selectedRemoteTrackedPresence || selectedRemoteSource?.summary.hasTracked);
  return {
    activeTrackedPresence,
    selectedRemoteHasTracked,
    hasTrackedSource: Boolean(activeTrackedPresence || selectedRemoteHasTracked),
    canTrackRemote: Boolean(selectedRemoteSource?.detail?.primaryCode && !selectedRemoteHasTracked),
  };
}

export function persistedDirectoryLoadState({
  work,
  selectedRemoteSource,
  selectedRemoteDetail,
  selectedRemoteTreeError,
  selectedRemoteTreeLoading,
  mediaError,
  isDirectoryLoading,
}: {
  work: WorkDetail | null;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteDetail: RemoteWorkDetail | null;
  selectedRemoteTreeError: string;
  selectedRemoteTreeLoading: boolean;
  mediaError: string;
  isDirectoryLoading: boolean;
}) {
  const sourceDetailsLoading = Boolean(
    selectedRemoteSource &&
    !selectedRemoteDetail &&
    !selectedRemoteSource.error &&
    remoteSourceCanBrowse(selectedRemoteSource.summary),
  );
  const mediaLoadError = selectedRemoteSource ? selectedRemoteTreeError : mediaError;
  return {
    sourceDetailsLoading,
    mediaLoadError,
    showSkeleton: !mediaLoadError && (!work || isDirectoryLoading || sourceDetailsLoading || selectedRemoteTreeLoading),
  };
}

export function persistedActiveSourceLabel(
  selectedTrackedPresence: SourcePresenceItem | null,
  selectedSource: SourceTabInfo | null | undefined,
) {
  return (
    selectedTrackedPresence?.fileSourceName ||
    selectedTrackedPresence?.fileSourceCode ||
    selectedSource?.sourceName ||
    selectedSource?.label ||
    i18n.t("libraryDetail.sourceInfo")
  );
}

export function persistedSourceInfo({
  label,
  selectedSource,
  directoryStats,
  isDirectoryLoading,
  selectedSourceDetailsLoading,
  selectedRemoteDetail,
  fallbackDurationSeconds,
}: {
  label: string;
  selectedSource: SourceTabInfo | null | undefined;
  directoryStats: TreeStats;
  isDirectoryLoading: boolean;
  selectedSourceDetailsLoading: boolean;
  selectedRemoteDetail: RemoteWorkDetail | null;
  fallbackDurationSeconds: number | null;
}): ActiveSourceInfoModel {
  const source = selectedSource
    ? { kind: selectedSource.kind, status: selectedSource.status, statusLabel: selectedSource.statusLabel }
    : { kind: "no_source" as const, status: "degraded" as const, statusLabel: i18n.t("libraryDetail.loadingSource") };
  return {
    label,
    ...source,
    stats: directoryStats,
    loading: isDirectoryLoading || selectedSourceDetailsLoading,
    metadataDurationSeconds: selectedRemoteDetail?.durationSeconds ?? fallbackDurationSeconds,
  };
}

export function persistedDisplayTranslations(
  localDirectoryWork: WorkDetail | null,
  selectedRemoteDetail: RemoteWorkDetail | null,
) {
  const localTranslations = localDirectoryWork?.translations ?? [];
  return selectedRemoteDetail
    ? mergeRemoteWorkVersions(localTranslations, selectedRemoteDetail.languageEditions ?? [])
    : localTranslations;
}

type PersistedPresentationWorkFields = {
  dlsiteUrl: string;
  title: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  baseCode: string | undefined;
  metadataLanguage: string | undefined;
  metadataPresentation: WorkMetadataPresentation | undefined;
  activeMetadataVariantKey: string;
  voiceCredits: VoiceCredit[];
  tags: string[];
};

function persistedPresentationWorkFields(
  work: WorkDetail | null,
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>,
  hero: ReturnType<typeof detailHeroModel>,
): PersistedPresentationWorkFields {
  if (!work) {
    return {
      dlsiteUrl: "",
      title: hero.title,
      seriesTitleId: "",
      seriesCircleExternalId: "",
      baseCode: undefined,
      metadataLanguage: undefined,
      metadataPresentation: undefined,
      activeMetadataVariantKey: "",
      voiceCredits: [],
      tags: hero.tags,
    };
  }
  return {
    dlsiteUrl: work.dlsiteUrl ?? "",
    title: activeMetadataVariant?.title ?? work.title ?? hero.title,
    seriesTitleId: work.seriesTitleId ?? "",
    seriesCircleExternalId: work.seriesCircleExternalId ?? work.circleExternalId ?? "",
    baseCode: work.baseCode,
    metadataLanguage: activeMetadataVariant?.language ?? work.metadataLanguage,
    metadataPresentation: work.metadataPresentation,
    activeMetadataVariantKey: activeMetadataVariant?.key ?? "",
    voiceCredits: work.voiceCredits ?? [],
    tags: activeMetadataVariant?.tags ?? hero.tags,
  };
}

export function persistedWorkDetailPresentation({
  hero,
  work,
  activeMetadataVariant,
  sourceInfo,
  displayTranslations,
  activeEditionCode,
  selectedRemoteDetail,
  personalTags,
  loading,
  metadataSync,
  canSyncMetadata,
  metadataSyncBusy,
  onSyncMetadata,
  onLinkMetadata,
  onMetadataVariantSelect,
  onVersionSelect,
}: {
  hero: ReturnType<typeof detailHeroModel>;
  work: WorkDetail | null;
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>;
  sourceInfo: ActiveSourceInfoModel;
  displayTranslations: WorkDetail["translations"];
  activeEditionCode: string;
  selectedRemoteDetail: RemoteWorkDetail | null;
  personalTags: ReactNode;
  loading: boolean;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata: boolean;
  metadataSyncBusy: boolean;
  onSyncMetadata: () => void;
  onLinkMetadata: () => void;
  onMetadataVariantSelect: (key: string) => void;
  onVersionSelect: (translation: WorkDetail["translations"][number]) => void;
}): UnifiedWorkDetailPresentation {
  const fields = persistedPresentationWorkFields(work, activeMetadataVariant, hero);
  return {
    coverUrl: hero.coverUrl,
    fallbackCode: hero.primaryCode,
    code: hero.primaryCode,
    dlsiteUrl: fields.dlsiteUrl,
    customWork: Boolean(work?.customWork),
    title: fields.title,
    description: activeMetadataVariant?.description ?? work?.description,
    circle: hero.circle,
    circleExternalId: hero.circleExternalId,
    series: hero.series,
    seriesTitleId: fields.seriesTitleId,
    seriesCircleExternalId: fields.seriesCircleExternalId,
    ratingLabel: i18n.t("libraryDetail.dlRating"),
    rating: hero.rating,
    ratingCount: hero.ratingCount,
    userRating: work?.userRating ?? null,
    sales: hero.sales,
    baseCode: fields.baseCode,
    metadataLanguage: fields.metadataLanguage,
    metadataPresentation: fields.metadataPresentation,
    metadataSync,
    canSyncMetadata,
    metadataSyncBusy,
    onSyncMetadata,
    onLinkMetadata,
    activeMetadataVariantKey: fields.activeMetadataVariantKey,
    onMetadataVariantSelect,
    translations: displayTranslations,
    activeVersionCode: activeEditionCode || selectedRemoteDetail?.remoteCode || hero.primaryCode,
    onVersionSelect,
    remoteVersions: Boolean(selectedRemoteDetail),
    dlsiteFetchedAt: hero.dlsiteFetchedAt,
    releaseDate: hero.releaseDate || i18n.t("libraryDetail.unknownReleaseDate"),
    ageRating: hero.ageRating,
    sourceInfo,
    voiceActors: hero.voiceActors,
    voiceCredits: fields.voiceCredits,
    staffCredits: work?.staffCredits ?? [],
    purchaseBonus: work?.purchaseBonus,
    purchaseBonuses: work?.purchaseBonuses,
    bundleMembers: work?.bundleMembers,
    includedInBundles: work?.includedInBundles,
    tags: fields.tags,
    personalTags,
    loading,
  };
}

import { GitFork, HardDriveDownload } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { CompactWorkCardShell, type CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import { openWorkDetail } from "@/app/workDetailNavigation";
import {
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  WorkCardSelection,
  WorkCardShell,
  dlsiteTagBadges,
  userTagBadges,
  type WorkCardBadge,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { circleSourceBadges } from "@/components/work-card/sourceBadges";
import type { CircleSourceStat, ListeningStatus } from "@/lib/api";
import { DLSITE_ENDPOINTS } from "@/lib/official-links";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import { openCircleRoute, openCircleSeriesRoute } from "@/lib/circleNavigationState";
import { currentVoiceReturnPath } from "@/lib/voiceNavigationState";
import { openLibraryTagSearch } from "@/lib/libraryTagSearch";
import { voiceWorkObservedSourceTags, voiceWorkRemoteTarget, type VoiceWorkView } from "@/pages/voiceWorkModel";
import { voiceWorkIsExplicitlyUnavailable } from "@/pages/voiceWorkAvailabilityModel";

const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Shelved" },
];

export function VoiceWorkCard({
  work,
  layout,
  selected,
  selectable,
  selectionActive,
  onSelectedChange,
  onFork,
  onSave,
  onStatusChange,
  canMark,
  onFavoriteSaved,
  onEnsureWork,
}: {
  work: VoiceWorkView;
  /** The reduced card layout of the chosen card mode, or null for the regular card. */
  layout: CompactWorkCardLayout | null;
  selected: boolean;
  selectable: boolean;
  selectionActive: boolean;
  onSelectedChange: (checked: boolean) => void;
  onFork: () => void;
  onSave: () => void;
  onStatusChange: (status: ListeningStatus) => void;
  /** Checked before the mark menu opens. */
  canMark: () => boolean;
  onFavoriteSaved: (favorite: boolean) => void;
  onEnsureWork: () => Promise<number | null>;
}) {
  const { t } = useTranslation();
  const isKnown = "local" in work;
  const workId = "workId" in work ? work.workId : null;
  const favorite = "favorite" in work ? work.favorite : false;
  const listeningMark = "listeningMark" in work ? work.listeningMark : "none";
  const isUnavailable = voiceWorkIsExplicitlyUnavailable(work);
  const canOpen = Boolean((isKnown && workId) || (!isKnown && work.primaryCode));
  const view = voiceWorkCardView(work, t);
  const Shell = layout ? CompactWorkCardShell : WorkCardShell;

  return (
    <Shell
      layout={layout ?? "row"}
      work={view}
      selection={
        selectionActive ? (
          <WorkCardSelection checked={selected} disabled={!selectable} onChange={onSelectedChange} />
        ) : undefined
      }
      canOpen={canOpen}
      onOpen={() => openWorkRoute(work)}
      onCircleOpen={(externalId) => openCircleRoute(externalId)}
      onSeriesOpen={
        "seriesTitleId" in work && work.seriesTitleId && "circleExternalId" in work && work.circleExternalId
          ? () => openCircleSeriesRoute(work.circleExternalId, work.seriesTitleId)
          : undefined
      }
      onTagOpen={(tag) => openLibraryTagSearch("tag", tag)}
      footer={
        <WorkCardFooter
          className={layout === "row" ? "h-10 border-border/40" : undefined}
          left={<WorkCardDLsiteAction href={voiceWorkDLsiteURL(work)} />}
          right={
            <>
              <WorkCardActionButton
                title={t("detailActions.fork")}
                disabled={!voiceWorkRemoteTarget(work)}
                onClick={(event) => {
                  event.stopPropagation();
                  onFork();
                }}
              >
                <GitFork className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardActionButton
                title={t("detailActions.fetch")}
                disabled={!voiceWorkRemoteTarget(work)}
                onClick={(event) => {
                  event.stopPropagation();
                  onSave();
                }}
              >
                <HardDriveDownload className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardListButton
                workId={workId}
                active={favorite}
                disabled={!workId && !voiceWorkRemoteTarget(work)}
                ensureWorkId={onEnsureWork}
                onSaved={onFavoriteSaved}
              />
              <WorkCardQuickMarkButton
                value={normalizeListeningStatus(listeningMark)}
                disabled={isUnavailable && !voiceWorkRemoteTarget(work)}
                canOpen={canMark}
                onChange={onStatusChange}
              />
            </>
          }
        />
      }
    />
  );
}

function voiceWorkCardView(work: VoiceWorkView, t: TFunction): WorkCardViewModel {
  const isKnown = "local" in work;
  const sourceName = "sourceName" in work ? work.sourceName : "";
  const observedSourceTags = voiceWorkObservedSourceTags(work);
  const availableBadges = isKnown
    ? circleSourceBadges({ local: work.local, remote: work.remote, cache: work.cache, sourceTags: observedSourceTags })
    : circleSourceBadges({
        local: work.hasLocal,
        remote: work.hasRemote || work.remotePlayable,
        cache: work.hasCache,
        sourceTags: observedSourceTags,
      });
  const observedStatusBadges = voiceObservedStatusBadges(observedSourceTags, t);
  const sourceBadges =
    availableBadges.length > 0 || observedStatusBadges.length > 0
      ? [...availableBadges, ...observedStatusBadges]
      : [
          {
            key: "source:unknown",
            label: t("creatorBrowse.sourceNotChecked"),
            variant: "warning" as const,
            title: t("creatorBrowse.sourceNotCheckedDescription"),
          },
        ];
  return {
    code: work.primaryCode || sourceName || t("detailActions.source"),
    title: work.title,
    circle: work.circle || sourceName || t("workCard.unknownCircle"),
    circleExternalId: "circleExternalId" in work ? work.circleExternalId : undefined,
    ageRating: work.ageRating,
    voiceActors: work.voiceActors,
    voiceCredits: "voiceCredits" in work ? work.voiceCredits : undefined,
    coverUrl: work.coverUrl,
    rating: work.rating,
    ratingCount: work.ratingCount,
    sales: work.sales,
    regularPrice: "regularPrice" in work ? work.regularPrice : null,
    price: work.price,
    priceCurrency: "priceCurrency" in work ? work.priceCurrency : "JPY",
    series: "series" in work ? work.series || null : null,
    hasLyrics: work.hasLyrics,
    hasPlaybackHistory: "progress" in work && hasPlaybackHistory(work.progress),
    dlsiteTags: dlsiteTagBadges(work.tags),
    userTags: isKnown ? userTagBadges(work.userTags ?? [], (tag) => openLibraryTagSearch("user_tag", tag)) : [],
    sourceBadges,
  };
}

function voiceWorkDLsiteURL(work: VoiceWorkView) {
  return "dlsiteUrl" in work && work.dlsiteUrl ? work.dlsiteUrl : DLSITE_ENDPOINTS.workURL("maniax", work.primaryCode);
}

function normalizeListeningStatus(status: string): ListeningStatus {
  return listeningStatusOptions.some((option) => option.value === status) ? (status as ListeningStatus) : "none";
}

function voiceObservedStatusBadges(sourceTags: CircleSourceStat[], t: TFunction): WorkCardBadge[] {
  return sourceTags
    .filter((source) => source.sourceId && source.key !== "cache" && source.status !== "available" && source.count <= 0)
    .map((source) => {
      const status = voiceSourceStatusLabel(source.status, t);
      return {
        key: `source:observed:${source.sourceId}`,
        label: `${source.displayName || t("detailActions.remote")}: ${status}`,
        variant: "warning" as const,
        title: t("creatorBrowse.observedSourceStatus", { status }),
      };
    });
}

function voiceSourceStatusLabel(status: string, t: TFunction) {
  switch (status) {
    case "not_found":
      return t("errors.notFound");
    case "unavailable":
      return t("detailActions.unavailable");
    case "disabled":
      return t("sources.disabled");
    case "error":
      return t("creatorBrowse.sourceError");
    default:
      return t("creatorBrowse.sourceNotChecked");
  }
}

function openWorkRoute(work: VoiceWorkView) {
  const remoteTarget = voiceWorkRemoteTarget(work);
  const options = { returnTo: currentVoiceReturnPath(), returnLabel: "Back to voices", workPreview: work };
  if (work.workId) {
    openWorkDetail(
      {
        kind: "known",
        canonicalCode: work.primaryCode,
        source: remoteTarget ? { sourceId: remoteTarget.sourceId, remoteCode: remoteTarget.code } : null,
      },
      options,
    );
    return;
  }
  if (remoteTarget) {
    openWorkDetail({ kind: "remote-only", sourceId: remoteTarget.sourceId, remoteCode: remoteTarget.code }, options);
  }
}

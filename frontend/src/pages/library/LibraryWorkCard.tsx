import { HardDriveDownload, Unlink } from "lucide-react";
import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { MobileWorkCardShell, type MobileWorkCardLayout } from "@/components/work-card/MobileWorkCard";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import {
  dlsiteTagBadges,
  userTagBadges,
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  WorkCardShell,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import i18n from "@/i18n";
import type { ListeningStatus, SourcePresenceItem, Work } from "@/lib/api";
import { openCircleRoute, openCircleSeriesRoute } from "@/lib/circleNavigationState";
import { hasPlaybackHistory } from "@/lib/playbackHistory";

import { libraryCoverSourceBadges } from "./libraryCoverSources";
import type { LocalLibraryScope } from "./libraryRoutes";
import { progressPercent, recentProgressLabel } from "./recentPlayback";

export const LibraryWorkCard = memo(function LibraryWorkCard({
  work,
  showRecommendationScore,
  onRecommendationOpen,
  onOpen,
  onStatusChange,
  onFavoriteSaved,
  onTagOpen,
  onUserTagOpen,
  coverSourceScope,
  coverSourceMode,
  onUntrack,
  canUntrack,
  isUntracking = false,
  onFetch,
  isFetchBusy,
  mobileLayout = null,
}: {
  work: Work;
  showRecommendationScore: boolean;
  onRecommendationOpen: (work: Work) => void;
  onOpen: (work: Work) => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onFavoriteSaved: (work: Work, favorite: boolean) => void;
  onTagOpen: (tag: string) => void;
  onUserTagOpen: (tag: string) => void;
  coverSourceScope: LocalLibraryScope;
  coverSourceMode: SourceVisibilityMode;
  onUntrack?: (work: Work, source: SourcePresenceItem) => Promise<void>;
  /** Checked before the untrack choices open. */
  canUntrack?: () => boolean;
  isUntracking?: boolean;
  onFetch?: (work: Work, source: SourcePresenceItem) => void;
  isFetchBusy?: boolean;
  mobileLayout?: MobileWorkCardLayout | null;
}) {
  const { t } = useTranslation();
  const Shell = mobileLayout ? MobileWorkCardShell : WorkCardShell;
  const baseView = libraryWorkCardView(work, onUserTagOpen, showRecommendationScore, useAuth().recommendationThreshold);
  const view: WorkCardViewModel = {
    ...baseView,
    ...libraryCoverSourceBadges(baseView.sourceBadges, { kind: coverSourceScope }, coverSourceMode),
    sourceBadgeStyle: "icon",
  };
  const trackedSources = trackedSourcesForWork(work);
  const trackedSource = trackedSources[0] ?? null;
  const untrackAnchorRef = useRef<HTMLDivElement | null>(null);
  const [untrackOpen, setUntrackOpen] = useState(false);

  return (
    <Shell
      layout={mobileLayout ?? "row"}
      work={view}
      onOpen={() => onOpen(work)}
      onRecommendationOpen={() => onRecommendationOpen(work)}
      onCircleOpen={(externalId) => openCircleRoute(externalId)}
      onSeriesOpen={
        work.seriesTitleId && work.circleExternalId
          ? () => openCircleSeriesRoute(work.circleExternalId, work.seriesTitleId)
          : undefined
      }
      onTagOpen={onTagOpen}
      footer={
        <WorkCardFooter
          className={mobileLayout === "row" ? "h-10 border-border/40" : undefined}
          left={<WorkCardDLsiteAction href={work.dlsiteUrl} />}
          right={
            <>
              {onUntrack && trackedSources.length > 0 && (
                <div className="relative" ref={untrackAnchorRef}>
                  <WorkCardActionButton
                    title={i18n.t("detailActions.untrack")}
                    disabled={isUntracking}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!untrackOpen && canUntrack && !canUntrack()) return;
                      setUntrackOpen((current) => !current);
                    }}
                  >
                    <Unlink className="h-4 w-4" />
                  </WorkCardActionButton>
                  <AnchoredPopover
                    open={untrackOpen && !isUntracking}
                    anchorRef={untrackAnchorRef}
                    onOpenChange={setUntrackOpen}
                    className="w-[min(18rem,calc(100vw-1.5rem))] p-2 text-sm"
                    bottomCollisionPadding={96}
                    zIndex={70}
                  >
                    <div className="space-y-2">
                      <div className="font-medium">{i18n.t("libraryDetail.untrackSource")}</div>
                      <p className="text-xs text-muted-foreground">{t("libraryDetail.untrackDescription")}</p>
                      <div className="space-y-1">
                        {trackedSources.map((source) => {
                          const sourceName =
                            source.fileSourceName || source.fileSourceCode || t("libraryDetail.sourceInfo");
                          return (
                            <button
                              key={`${source.workId ?? work.id}:${source.fileSourceId ?? 0}`}
                              className="flex min-h-10 w-full items-center gap-2 rounded-md border border-destructive/30 px-2 text-left text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                              disabled={isUntracking}
                              onClick={(event) => {
                                event.stopPropagation();
                                void onUntrack(work, source).finally(() => setUntrackOpen(false));
                              }}
                            >
                              <Unlink className="h-4 w-4 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">
                                {t("libraryDetail.untrackNamedSource", { source: sourceName })}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </AnchoredPopover>
                </div>
              )}
              {onUntrack && (
                <WorkCardActionButton
                  title={i18n.t("detailActions.fetch")}
                  disabled={!trackedSource || isFetchBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (trackedSource) onFetch?.(work, trackedSource);
                  }}
                >
                  <HardDriveDownload className="h-4 w-4" />
                </WorkCardActionButton>
              )}
              <WorkCardListButton
                workId={work.id}
                active={work.favorite}
                onSaved={(favorite) => onFavoriteSaved(work, favorite)}
              />
              <WorkCardQuickMarkButton
                value={work.listeningStatus}
                onChange={(status) => void onStatusChange(work.id, status)}
              />
            </>
          }
        />
      }
    />
  );
});

function libraryWorkCardView(
  work: Work,
  onUserTagOpen?: (tag: string) => void,
  showRecommendationScore = false,
  threshold = 50,
): WorkCardViewModel {
  return {
    code: work.primaryCode,
    title: work.title,
    circle: work.circle || i18n.t("workCard.unknownCircle"),
    circleExternalId: work.circleExternalId,
    ageRating: work.ageRating,
    voiceActors: work.voiceActors,
    voiceCredits: work.voiceCredits,
    coverUrl: work.coverUrl,
    rating: work.rating,
    ratingCount: work.ratingCount,
    sales: work.sales,
    regularPrice: work.regularPrice,
    price: work.price,
    priceCurrency: work.priceCurrency,
    series: work.series || null,
    hasLyrics: work.hasLyrics,
    hasPlaybackHistory: hasPlaybackHistory(work.progress),
    progress: hasPlaybackHistory(work.progress)
      ? { percent: progressPercent(work.progress), label: recentProgressLabel(work.progress, i18n.t) }
      : null,
    dlsiteTags: dlsiteTagBadges(work.tags),
    userTags: userTagBadges(work.userTags ?? [], onUserTagOpen),
    sourceBadges: sourcePresenceBadges(work.sourcePresence, work.availability),
    recommended: showRecommendationScore && Number.isFinite(work.recommendScore),
    recommendationHighlighted: work.recommendScore >= threshold,
    recommendationScore: work.recommendScore,
  };
}

function trackedSourcesForWork(work: Work) {
  return (work.sourcePresence ?? []).filter(
    (item) => item.type === "tracked" && item.availability === "available" && item.fileSourceId,
  );
}

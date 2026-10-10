import { GitFork, HardDriveDownload } from "lucide-react";

import { useAuth } from "@/auth/AuthProvider";
import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import { MobileWorkCardShell, type MobileWorkCardLayout } from "@/components/work-card/MobileWorkCard";
import {
  dlsiteTagBadges,
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  WorkCardSelection,
  WorkCardShell,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { dlsiteWorkURL } from "@/features/work-detail/workDetailShared";
import i18n from "@/i18n";
import type { LibrarySource, ListeningStatus, RemoteWork } from "@/lib/api";

import { libraryCoverSourceBadges } from "./libraryCoverSources";

export function RemoteWorkCard({
  work,
  recommendationScored,
  revealDelay,
  source,
  coverSourceMode,
  selected,
  selectable,
  selectionActive,
  isBusy,
  onSelectedChange,
  onOpen,
  onFork,
  onTagOpen,
  onMark,
  canMark,
  onSave,
  onEnsureWork,
  onListSaved,
  mobileLayout,
}: {
  work: RemoteWork;
  recommendationScored: boolean;
  revealDelay: number;
  source: LibrarySource;
  coverSourceMode: SourceVisibilityMode;
  selected: boolean;
  selectable: boolean;
  selectionActive: boolean;
  isBusy: boolean;
  onSelectedChange: (checked: boolean) => void;
  onOpen: () => void;
  onFork: () => void;
  onTagOpen: (tag: string) => void;
  onMark: (status: ListeningStatus) => void;
  /** Checked before the mark menu opens. */
  canMark: () => boolean;
  onSave: () => void;
  onEnsureWork: () => Promise<number | null>;
  onListSaved: (workId: number, favorite: boolean) => void;
  mobileLayout: MobileWorkCardLayout | null;
}) {
  const Shell = mobileLayout ? MobileWorkCardShell : WorkCardShell;
  const baseView = remoteWorkCardView(work, source, recommendationScored, useAuth().recommendationThreshold);
  const view: WorkCardViewModel = {
    ...baseView,
    ...libraryCoverSourceBadges(baseView.sourceBadges, { kind: "remote", sourceId: source.id }, coverSourceMode),
    sourceBadgeStyle: "icon",
    recommendationRevealDelay: revealDelay,
  };

  return (
    <Shell
      layout={mobileLayout ?? "row"}
      work={view}
      selection={
        selectionActive ? (
          <WorkCardSelection checked={selected} disabled={!selectable} onChange={onSelectedChange} />
        ) : undefined
      }
      onOpen={onOpen}
      onTagOpen={onTagOpen}
      canOpen={Boolean(work.primaryCode)}
      footer={
        <WorkCardFooter
          className={mobileLayout === "row" ? "h-10 border-border/40" : undefined}
          left={<WorkCardDLsiteAction href={dlsiteWorkURL(work.primaryCode)} />}
          right={
            <>
              <WorkCardActionButton
                title={i18n.t("detailActions.fork")}
                disabled={isBusy || !work.primaryCode}
                onClick={(event) => {
                  event.stopPropagation();
                  onFork();
                }}
              >
                <GitFork className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardActionButton
                title={i18n.t("detailActions.fetch")}
                disabled={isBusy || !work.primaryCode}
                onClick={(event) => {
                  event.stopPropagation();
                  onSave();
                }}
              >
                <HardDriveDownload className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardListButton
                workId={work.workId}
                active={work.favorite}
                disabled={isBusy || !work.primaryCode}
                ensureWorkId={onEnsureWork}
                onSaved={(favorite, workId) => onListSaved(workId, favorite)}
              />
              <WorkCardQuickMarkButton
                value={work.listeningStatus}
                disabled={isBusy || !work.primaryCode}
                canOpen={canMark}
                onChange={onMark}
              />
            </>
          }
        />
      }
    />
  );
}

function remoteWorkCardView(
  work: RemoteWork,
  source: LibrarySource,
  scored: boolean,
  threshold: number,
): WorkCardViewModel {
  const sourceLabel = source.displayName || source.code || i18n.t("workCard.remoteSource");
  return {
    code: work.primaryCode || work.remoteId,
    title: work.title,
    circle: work.circle || sourceLabel || i18n.t("workCard.unknownCircle"),
    ageRating: work.ageRating,
    voiceActors: work.voiceActors,
    coverUrl: work.coverUrl,
    rating: work.rating,
    ratingCount: work.ratingCount,
    sales: work.sales,
    price: work.price,
    priceCurrency: "JPY",
    series: null,
    hasLyrics: work.hasLyrics,
    dlsiteTags: dlsiteTagBadges(work.tags),
    userTags: [],
    recommended: scored && Number.isFinite(work.recommendScore),
    recommendationHighlighted: work.recommendScore >= threshold,
    recommendationScore: work.recommendScore,
    sourceBadges: work.remotePlayable
      ? [{ key: `source:remote:${source.id}`, label: sourceLabel, variant: "outline" }]
      : [
          {
            key: `source:remote:${source.id}:unavailable`,
            label: i18n.t("workCard.namedSourceUnavailable", { name: sourceLabel }),
            variant: "warning",
          },
        ],
  };
}

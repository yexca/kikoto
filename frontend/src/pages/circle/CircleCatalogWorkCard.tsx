import { CircleAlert, GitFork, HardDriveDownload } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
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
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { CompactWorkCardShell, type CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import { circleSourceBadges } from "@/components/work-card/sourceBadges";
import type { CircleCatalogWork, ListeningStatus } from "@/lib/api";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import { openWorkDetail, type WorkDetailIntent } from "@/app/workDetailNavigation";
import { currentCircleReturnPath, openCircleRoute } from "@/lib/circleNavigationState";
import { openLibraryTagSearch } from "@/lib/libraryTagSearch";
import {
  normalizeListeningStatus,
  preferredDirectoryTarget,
  circleWorkRemoteTarget,
  dlsiteWorkURL,
} from "@/pages/circle/circleWorkModel";

export function CatalogWorkCard({
  work,
  layout,
  busy,
  selected,
  selectable,
  selectionActive,
  onSelectedChange,
  onFork,
  onSave,
  onDeleteMissing,
  onStatusChange,
  canMark,
  onFavoriteSaved,
  onEnsureWork,
  onSeriesOpen,
}: {
  work: CircleCatalogWork;
  /** The reduced card layout of the chosen card mode, or null for the regular card. */
  layout: CompactWorkCardLayout | null;
  busy: boolean;
  selected: boolean;
  selectable: boolean;
  selectionActive: boolean;
  onSelectedChange: (checked: boolean) => void;
  onFork: () => void;
  onSave: () => void;
  onDeleteMissing: () => void;
  onStatusChange: (status: ListeningStatus) => void;
  /** Checked before the mark menu opens. */
  canMark: () => boolean;
  onFavoriteSaved: (favorite: boolean) => void;
  onEnsureWork: () => Promise<number | null>;
  onSeriesOpen?: () => void;
}) {
  const { t } = useTranslation();
  const directoryTarget = preferredDirectoryTarget(work);
  const isUnavailable = !work.local && !work.remote;
  const view = catalogWorkCardView(work, t);
  const Shell = layout ? CompactWorkCardShell : WorkCardShell;

  const openTarget = () => {
    if (directoryTarget) openWorkDirectoryRoute(directoryTarget, work);
  };

  return (
    <Shell
      layout={layout ?? "row"}
      work={view}
      selection={
        selectionActive ? (
          <WorkCardSelection checked={selected} disabled={!selectable} onChange={onSelectedChange} />
        ) : undefined
      }
      canOpen={Boolean(directoryTarget)}
      onOpen={openTarget}
      onCircleOpen={(externalId) => openCircleRoute(externalId)}
      onSeriesOpen={work.series ? onSeriesOpen : undefined}
      onTagOpen={(tag) => openLibraryTagSearch("tag", tag)}
      footer={
        <WorkCardFooter
          className={layout === "row" ? "h-10 border-border/40" : undefined}
          left={<WorkCardDLsiteAction href={work.dlsiteUrl || dlsiteWorkURL(work.primaryCode)} />}
          right={
            <>
              <WorkCardActionButton
                title={t("detailActions.fork")}
                disabled={busy || !circleWorkRemoteTarget(work)}
                onClick={(event) => {
                  event.stopPropagation();
                  onFork();
                }}
              >
                <GitFork className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardActionButton
                title={t("detailActions.fetch")}
                disabled={busy || !circleWorkRemoteTarget(work)}
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
                disabled={!circleWorkRemoteTarget(work) && !work.workId}
                ensureWorkId={onEnsureWork}
                onSaved={onFavoriteSaved}
              />
              <WorkCardQuickMarkButton
                value={normalizeListeningStatus(work.listeningMark)}
                disabled={isUnavailable && !circleWorkRemoteTarget(work)}
                canOpen={canMark}
                onChange={onStatusChange}
              />
              {!work.dlsiteAvailable && (
                <WorkCardActionButton
                  title={t("detailActions.deleteMissingCatalogItem")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteMissing();
                  }}
                >
                  <CircleAlert className="h-4 w-4" />
                </WorkCardActionButton>
              )}
            </>
          }
        />
      }
    />
  );
}

export function CatalogDeleteConfirmModal({
  work,
  onClose,
  onConfirm,
}: {
  work: CircleCatalogWork;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onClose} size="md" role="alertdialog">
      <DialogHeader
        title={t("detailActions.removeCatalogWork")}
        description={t("detailActions.removeCatalogWorkDescription", { code: work.primaryCode })}
      />
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("content.cancel")}
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm}>
          {t("admin.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function catalogWorkCardView(work: CircleCatalogWork, t: TFunction): WorkCardViewModel {
  const sourceBadges = circleSourceBadges({ local: work.local, remote: work.remote, sourceTags: work.sourceTags });
  const statusBadges = [
    ...(work.catalogStatus !== "imported"
      ? [{ key: `catalog:${work.catalogStatus}`, label: work.catalogStatus, variant: "outline" as const }]
      : []),
    ...(!work.dlsiteAvailable
      ? [{ key: "dlsite:missing", label: t("workCard.dlsiteMissing"), variant: "warning" as const }]
      : []),
    ...sourceBadges,
  ];
  return {
    code: work.primaryCode,
    title: work.title,
    circle: work.circle || t("workCard.unknownCircle"),
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
    dlsiteTags: dlsiteTagBadges(work.tags),
    userTags: userTagBadges(work.userTags ?? [], (tag) => openLibraryTagSearch("user_tag", tag)),
    sourceBadges: statusBadges,
  };
}

function openWorkDirectoryRoute(target: WorkDetailIntent, work: CircleCatalogWork) {
  openWorkDetail(target, { returnTo: currentCircleReturnPath(), returnLabel: "Back to circle", workPreview: work });
}

import { Check, GitFork, HardDriveDownload, Languages } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { CompactWorkCardShell, type CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import {
  dlsiteTagBadges,
  userTagBadges,
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
import type { LibrarySource, ListeningStatus, RemoteWork, RemoteWorkEdition } from "@/lib/api";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { cn } from "@/lib/tailwindClassNames";

import { libraryCoverSourceBadges } from "./libraryCoverSources";
import { remoteWorkActionCode, remoteWorkEditionChoices, remoteWorkPresentsEdition } from "./remoteSourceBrowseModel";
import { remoteWorkSourceBadges } from "./remoteWorkCardSources";

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
  onOpenEdition,
  onFork,
  onTagOpen,
  onUserTagOpen,
  onMark,
  canMark,
  onSave,
  onEnsureWork,
  onListSaved,
  layout,
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
  /** Opens one folded edition's source page. */
  onOpenEdition: (edition: RemoteWorkEdition) => void;
  onFork: () => void;
  onTagOpen: (tag: string) => void;
  onUserTagOpen: (tag: string) => void;
  onMark: (status: ListeningStatus) => void;
  /** Checked before the mark menu opens. */
  canMark: () => boolean;
  onSave: () => void;
  onEnsureWork: () => Promise<number | null>;
  onListSaved: (workId: number, favorite: boolean) => void;
  layout: CompactWorkCardLayout | null;
}) {
  const Shell = layout ? CompactWorkCardShell : WorkCardShell;
  const baseView = remoteWorkCardView(
    work,
    source,
    recommendationScored,
    useAuth().recommendationThreshold,
    onUserTagOpen,
  );
  const view: WorkCardViewModel = {
    ...baseView,
    ...libraryCoverSourceBadges(baseView.sourceBadges, { kind: "remote", sourceId: source.id }, coverSourceMode),
    sourceBadgeStyle: "icon",
    recommendationRevealDelay: revealDelay,
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
      onOpen={onOpen}
      onTagOpen={onTagOpen}
      canOpen={Boolean(work.primaryCode)}
      footer={
        <WorkCardFooter
          className={layout === "row" ? "h-10 border-border/40" : undefined}
          left={
            <>
              <WorkCardDLsiteAction href={dlsiteWorkURL(remoteWorkActionCode(work))} />
              <RemoteWorkEditionsButton work={work} onOpenEdition={onOpenEdition} />
            </>
          }
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

/**
 * Lists the editions of the card's work family that the source returned; the
 * card presents one of them, and choosing another opens that edition.
 */
function RemoteWorkEditionsButton({
  work,
  onOpenEdition,
}: {
  work: RemoteWork;
  onOpenEdition: (edition: RemoteWorkEdition) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const editions = remoteWorkEditionChoices(work);
  if (editions.length === 0) return null;
  const label = t("library.remoteEditions", { count: editions.length });
  return (
    <div className="relative" ref={anchorRef}>
      <WorkCardActionButton
        title={label}
        popup="dialog"
        expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Languages className="h-4 w-4" />
      </WorkCardActionButton>
      <span
        className="pointer-events-none absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-muted px-1 text-3xs font-semibold tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        {editions.length}
      </span>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        ariaLabel={label}
        className="w-64 p-1 text-sm"
      >
        <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{label}</div>
        {editions.map((edition) => {
          const presented = remoteWorkPresentsEdition(work, edition);
          return (
            <button
              key={`${edition.remoteCode}:${edition.remoteId}`}
              type="button"
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted",
                presented && "bg-primary/10 text-primary",
              )}
              aria-current={presented ? "true" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                onOpenEdition(edition);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {remoteEditionLanguageName(edition)}
                  {edition.origin && (
                    <span className="ml-1.5 text-xs text-muted-foreground">{t("libraryDetail.original")}</span>
                  )}
                </span>
                <span className="block truncate font-mono text-2xs text-muted-foreground">{edition.remoteCode}</span>
              </span>
              {presented && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            </button>
          );
        })}
      </AnchoredPopover>
    </div>
  );
}

function remoteEditionLanguageName(edition: RemoteWorkEdition) {
  const known = metadataTagNameLanguages.find(([language]) => language === edition.language);
  if (known) return i18n.t(known[1]);
  return edition.label || edition.language || edition.title || edition.remoteCode;
}

function remoteWorkCardView(
  work: RemoteWork,
  source: LibrarySource,
  scored: boolean,
  threshold: number,
  onUserTagOpen: (tag: string) => void,
): WorkCardViewModel {
  const sourceLabel = source.displayName || source.code || i18n.t("workCard.remoteSource");
  return {
    // The code of the presented edition, whose title and cover the card shows.
    code: remoteWorkActionCode(work),
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
    userTags: userTagBadges(work.userTags, onUserTagOpen),
    recommended: scored && Number.isFinite(work.recommendScore),
    recommendationHighlighted: work.recommendScore >= threshold,
    recommendationScore: work.recommendScore,
    sourceBadges: remoteWorkSourceBadges(work, source.id, sourceLabel),
  };
}

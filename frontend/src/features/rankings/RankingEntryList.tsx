import { ArrowDown, ArrowUp, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { LayoutWorkCard, type CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import { WorkCardActionFooter } from "@/components/work-card/WorkCardActionFooter";
import { WorkCardContextItem, WorkCardContextStrip, WorkCardStatusBadge } from "@/components/work-card/WorkCardContext";
import { dlsiteTagBadges, userTagBadges, type WorkCardViewModel } from "@/components/work-card/WorkCardShell";
import {
  workCollectionClassName,
  workCollectionStyle,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkSectionHeading } from "@/components/work-collection/WorkSectionHeading";
import type { RankingChange, RankingDroppedItem, RankingItem, RankingPage, Work } from "@/lib/api";
import { openCircleRoute } from "@/lib/circleNavigationState";
import { shownWorkSourcePresence, type ShownWorksSourceCheck } from "@/lib/shownWorksSourceCheck";
import { cn } from "@/lib/tailwindClassNames";

import { matchesRankingFilter, rankingEntryFacts, type RankingFilter } from "./rankingModel";

type RankingEntry = RankingItem | RankingDroppedItem;

type EntryActions = {
  demo: boolean;
  cardLayout: CompactWorkCardLayout | null;
  canWatch: boolean;
  /** The account may add library works to lists, rate, and mark them. */
  canMark: boolean;
  /** Codes added to Availability Watch on this page, and those being added. */
  watched: Set<string>;
  watching: Set<string>;
  sourceCheck: ShownWorksSourceCheck;
  onWatch: (code: string) => void;
  onOpenWork: (code: string) => void;
  onWorkChange: (workId: number, patch: Partial<Work>) => void;
};

/**
 * The card of an entry. Its source badges follow what the work records and
 * this visit's source checks; an entry the library has no files for shows no
 * "no source" badge, since the ranking is not the library.
 */
function rankingCardView(item: RankingEntry, unknownCircle: string, check: ShownWorksSourceCheck): WorkCardViewModel {
  const work = item.work;
  const presence = shownWorkSourcePresence(item, check);
  const sourceBadges = sourcePresenceBadges(presence, work?.availability).filter(
    (badge) => item.inLibrary || badge.key !== "source:no-source",
  );
  if (work) {
    return {
      code: work.primaryCode,
      title: work.title || item.fallback.title,
      titleSource: work.titleSource,
      circle: work.circle || item.fallback.circle || unknownCircle,
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
      dlsiteTags: dlsiteTagBadges(work.tags),
      userTags: userTagBadges(work.userTags ?? []),
      sourceBadges,
      sourceBadgeStyle: "icon",
    };
  }
  const fallback = item.fallback;
  return {
    code: fallback.code,
    title: fallback.title || fallback.code,
    circle: fallback.circle || unknownCircle,
    coverUrl: fallback.coverUrl,
    dlsiteTags: [],
    sourceBadges,
    sourceBadgeStyle: "icon",
    sourceUnavailableFallback: false,
  };
}

/**
 * The shown order's entries as cards beside their rank in Discover's card
 * grid, narrowed by the filter, then the works that dropped out behind a
 * disclosure. A finished annual ranking and a past order show no stay or best
 * rank; an archive shows no movement either.
 */
export function RankingEntryList({
  page,
  filter,
  filters,
  mobileColumns,
  desktopColumns,
  droppedOpen,
  onDroppedOpenChange,
  ...actions
}: EntryActions & {
  page: RankingPage;
  filter: RankingFilter;
  filters: readonly RankingFilter[];
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  droppedOpen: boolean;
  onDroppedOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const archive = page.list.finalAt !== null;
  const history = page.at !== null;
  const items = page.items.filter((item) =>
    matchesRankingFilter(item, filters.includes(filter) ? filter : "all", actions.sourceCheck),
  );
  const now = new Date();
  const gridProps = {
    className: workCollectionClassName(),
    style: workCollectionStyle(mobileColumns, desktopColumns, actions.cardLayout),
  };

  return (
    <div className="space-y-6">
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("subscriptions.rankings.noMatches")}</p>
      ) : (
        <ol {...gridProps}>
          {items.map((item) => {
            const facts = archive || history ? null : rankingEntryFacts(item, now);
            const notes: string[] = [];
            if (facts?.streakDays) notes.push(t("subscriptions.rankings.streak", { count: facts.streakDays }));
            if (facts?.bestRank) notes.push(t("subscriptions.rankings.bestRank", { rank: facts.bestRank }));
            return (
              <RankingEntryCard
                key={item.code}
                item={item}
                rank={item.rank}
                change={archive ? null : item.change}
                notes={notes}
                {...actions}
              />
            );
          })}
        </ol>
      )}
      {!archive && page.dropped.length > 0 && (
        <section aria-labelledby="ranking-dropped-heading">
          <WorkSectionHeading
            id="ranking-dropped-heading"
            title={
              <button
                type="button"
                aria-expanded={droppedOpen}
                className="flex items-center gap-1.5 rounded-md hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onDroppedOpenChange(!droppedOpen)}
              >
                <ChevronDown
                  className={cn("h-4 w-4 shrink-0 transition-transform", !droppedOpen && "-rotate-90")}
                  aria-hidden="true"
                />
                {t("subscriptions.rankings.dropped")}
              </button>
            }
            count={page.dropped.length}
          />
          {droppedOpen && (
            <ol {...gridProps}>
              {page.dropped.map((item) => (
                <RankingEntryCard
                  key={item.code}
                  item={item}
                  rank={null}
                  change={null}
                  notes={[t("subscriptions.rankings.previousRank", { rank: item.previousRank })]}
                  {...actions}
                />
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * One entry: the rank and its movement beside the work's card, with the facts
 * worth stating above the card: a stay longer than a day and a best rank above
 * the current one, or the rank a dropped work had. The cover's source marks
 * say whether the library has the work.
 */
function RankingEntryCard({
  item,
  rank,
  change,
  notes,
  demo,
  cardLayout,
  canWatch,
  canMark,
  watched,
  watching,
  sourceCheck,
  onWatch,
  onOpenWork,
  onWorkChange,
}: EntryActions & {
  item: RankingEntry;
  /** Null for a work that dropped out. */
  rank: number | null;
  change: RankingChange | null;
  notes: string[];
}) {
  const { t } = useTranslation();
  const view = rankingCardView(item, t("workCard.unknownCircle"), sourceCheck);
  const footer = demo ? undefined : (
    <WorkCardActionFooter
      layout={cardLayout}
      dlsiteUrl={item.work?.dlsiteUrl || item.fallback.dlsiteUrl}
      watch={
        canWatch
          ? {
              watched: item.watched || watched.has(item.code),
              pending: watching.has(item.code),
              onWatch: () => onWatch(item.code),
            }
          : null
      }
      work={item.work}
      canMark={canMark}
      onWorkChange={onWorkChange}
    />
  );
  return (
    <WorkCardContextItem
      label={view.title}
      context={<WorkCardContextStrip detail={notes.join(" · ")} />}
      leading={
        // The rank lines up with the top of the card's content, below the context strip.
        <div
          className={cn(
            "flex w-10 shrink-0 flex-col items-center gap-1 sm:w-12",
            cardLayout === "row" ? "pt-10" : "pt-9",
          )}
        >
          {rank === null ? (
            <span className="text-base font-medium leading-6 text-muted-foreground tabular-nums" aria-hidden="true">
              —
            </span>
          ) : (
            <span
              className="text-xl font-semibold leading-6 tabular-nums"
              aria-label={t("subscriptions.rankings.rank", { rank })}
            >
              {rank}
            </span>
          )}
          {change && <RankingChangeMarker change={change} />}
        </div>
      }
    >
      <LayoutWorkCard
        layout={cardLayout}
        work={view}
        canOpen={!demo}
        onOpen={() => onOpenWork(item.code)}
        onCircleOpen={demo ? undefined : (externalId: string) => openCircleRoute(externalId)}
        footer={footer}
      />
    </WorkCardContextItem>
  );
}

/** Movement against the baseline: NEW and Back use the primary badge, arrows stay neutral, no change shows nothing. */
function RankingChangeMarker({ change }: { change: RankingChange }) {
  const { t } = useTranslation();
  if (change.kind === "new" || change.kind === "reentered") {
    return (
      <WorkCardStatusBadge tone="primary" className="uppercase tracking-wide">
        {t(`subscriptions.rankings.change.${change.kind}`)}
      </WorkCardStatusBadge>
    );
  }
  if (change.kind === "same") return null;
  const up = change.kind === "up";
  const count = Math.abs(change.delta);
  const label = t(`subscriptions.rankings.change.${change.kind}`, { count });
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground"
      title={label}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

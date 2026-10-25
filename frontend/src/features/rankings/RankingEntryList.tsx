import { ArrowDown, ArrowUp, ChevronDown, Library } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { CompactWorkCardShell } from "@/components/work-card/CompactWorkCard";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import { WorkCardWatchButton } from "@/components/work-card/WorkCardWatchButton";
import {
  dlsiteTagBadges,
  userTagBadges,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import type { RankingChange, RankingDroppedItem, RankingItem, RankingPage } from "@/lib/api";
import { openCircleRoute } from "@/lib/circleNavigationState";
import { shownWorkSourcePresence, type ShownWorksSourceCheck } from "@/lib/shownWorksSourceCheck";
import { cn } from "@/lib/tailwindClassNames";

import { matchesRankingFilter, rankingEntryFacts, type RankingFilter } from "./rankingModel";

type RankingEntry = RankingItem | RankingDroppedItem;

type EntryActions = {
  demo: boolean;
  canWatch: boolean;
  /** Codes added to Availability Watch on this page, and those being added. */
  watched: Set<string>;
  watching: Set<string>;
  sourceCheck: ShownWorksSourceCheck;
  onWatch: (code: string) => void;
  onOpenWork: (code: string) => void;
};

// The view's own width decides the columns, so the list reflows when the
// settings open beside it.
const entryGridClassName = "grid gap-3 sm:gap-4 @4xl:grid-cols-2 @7xl:grid-cols-3";

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
 * The shown order's entries as compact row cards beside their rank, narrowed
 * by the filter, then the works that dropped out behind a disclosure. A
 * finished annual ranking and a past order show no stay or best rank; an
 * archive shows no movement either.
 */
export function RankingEntryList({
  page,
  filter,
  filters,
  droppedOpen,
  onDroppedOpenChange,
  ...actions
}: EntryActions & {
  page: RankingPage;
  filter: RankingFilter;
  filters: readonly RankingFilter[];
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

  return (
    <div className="@container space-y-4">
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("subscriptions.rankings.noMatches")}</p>
      ) : (
        <ol className={entryGridClassName}>
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
        <section className="space-y-3">
          <button
            type="button"
            aria-expanded={droppedOpen}
            className="flex items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onDroppedOpenChange(!droppedOpen)}
          >
            <ChevronDown
              className={cn("h-4 w-4 transition-transform", !droppedOpen && "-rotate-90")}
              aria-hidden="true"
            />
            {t("subscriptions.rankings.dropped", { count: page.dropped.length })}
          </button>
          {droppedOpen && (
            <ol className={entryGridClassName}>
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
 * One entry: the rank and its movement beside the work's compact row card.
 * The card's footer holds the actions and states only the facts worth
 * stating: that the library has the work, a stay longer than a day, and a
 * best rank above the current one.
 */
function RankingEntryCard({
  item,
  rank,
  change,
  notes,
  demo,
  canWatch,
  watched,
  watching,
  sourceCheck,
  onWatch,
  onOpenWork,
}: EntryActions & {
  item: RankingEntry;
  /** Null for a work that dropped out. */
  rank: number | null;
  change: RankingChange | null;
  notes: string[];
}) {
  const { t } = useTranslation();
  const view = rankingCardView(item, t("workCard.unknownCircle"), sourceCheck);
  const facts = (item.inLibrary || notes.length > 0) && (
    <span className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
      {item.inLibrary && (
        <Badge variant="success" className="shrink-0 gap-1 px-1.5 py-0 text-2xs font-medium">
          <Library className="h-3 w-3" aria-hidden="true" />
          {t("subscriptions.rankings.inLibrary")}
        </Badge>
      )}
      {notes.length > 0 && <span className="truncate">{notes.join(" · ")}</span>}
    </span>
  );
  const footer = demo ? (
    facts && <WorkCardFooter className="h-10 border-border/40" left={facts} />
  ) : (
    <WorkCardFooter
      className="h-10 border-border/40"
      left={
        <>
          <WorkCardDLsiteAction href={item.work?.dlsiteUrl || item.fallback.dlsiteUrl} />
          {facts}
        </>
      }
      right={
        <>
          {canWatch && !item.inLibrary && (
            <WorkCardWatchButton
              watched={item.watched || watched.has(item.code)}
              pending={watching.has(item.code)}
              onWatch={() => onWatch(item.code)}
            />
          )}
          {item.work && <WorkCardListButton workId={item.work.id} active={item.work.favorite} />}
        </>
      }
    />
  );
  return (
    <li aria-label={view.title} className="flex min-w-0 gap-2 sm:gap-3">
      <div className="flex w-10 shrink-0 flex-col items-center gap-1 pt-2.5 sm:w-12">
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
      <div className="min-w-0 flex-1">
        <CompactWorkCardShell
          layout="row"
          work={view}
          canOpen={!demo}
          onOpen={() => onOpenWork(item.code)}
          onCircleOpen={demo ? undefined : (externalId: string) => openCircleRoute(externalId)}
          footer={footer || undefined}
        />
      </div>
    </li>
  );
}

/** Movement against the baseline: NEW and Back use the accent, arrows stay neutral, no change shows nothing. */
function RankingChangeMarker({ change }: { change: RankingChange }) {
  const { t } = useTranslation();
  if (change.kind === "new") {
    return (
      <Badge className="px-1.5 py-0 text-[10px] uppercase tracking-wide">
        {t("subscriptions.rankings.change.new")}
      </Badge>
    );
  }
  if (change.kind === "reentered") {
    return (
      <Badge variant="outline" className="border-primary/40 px-1.5 py-0 text-[10px] text-primary">
        {t("subscriptions.rankings.change.reentered")}
      </Badge>
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

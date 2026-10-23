import { ArrowDown, ArrowUp, ChevronDown, Eye, ListOrdered, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import { filterChipClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import { CompactWorkCardShell } from "@/components/work-card/CompactWorkCard";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import {
  dlsiteTagBadges,
  userTagBadges,
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type RankingChange, type RankingDroppedItem, type RankingItem, type RankingPage } from "@/lib/api";
import { openCircleRoute } from "@/lib/circleNavigationState";
import { parseServerTimestamp } from "@/lib/serverTimestamp";
import { cn } from "@/lib/tailwindClassNames";

import {
  matchesRankingFilter,
  RANKING_FILTERS,
  rankingFilterCounts,
  rankingListLabel,
  rankingStreakDays,
  type RankingFilter,
} from "./rankingModel";
import type { RankingOverviewState } from "./useRankingOverview";

function rankingCardView(item: RankingItem | RankingDroppedItem, unknownCircle: string): WorkCardViewModel {
  const work = item.work;
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
      sourceBadges: sourcePresenceBadges(work.sourcePresence, work.availability),
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
    sourceBadges: [],
    sourceUnavailableFallback: false,
  };
}

/**
 * One tracked ranking's latest order compared with a baseline: the account's
 * last visit by default, the previous update, or a picked update. Entries are
 * codes; one without a library work shows the ranking's own text.
 */
export function RankingsView({
  rankings,
  listId,
  compare,
  readOnly,
  canManage,
  canMarkSeen,
  canWatch,
  onListChange,
  onCompareChange,
  onOpenSettings,
  onOpenRun,
  onOpenWork,
}: {
  rankings: RankingOverviewState;
  /** The list named in the location, or null for the first one. */
  listId: number | null;
  /** "" for the last visit, "previous", or a snapshot id. */
  compare: string;
  readOnly: boolean;
  /** `metadata:sync`: rankings may be added and refreshed. */
  canManage: boolean;
  /** Opening a ranking records it as seen; Demo keeps its sample state. */
  canMarkSeen: boolean;
  /** The account may add works to Availability Watch. */
  canWatch: boolean;
  onListChange: (listId: number) => void;
  onCompareChange: (compare: string) => void;
  onOpenSettings: () => void;
  onOpenRun: (runId: number) => void;
  /** Opens a code; a remote list passes its source for codes without a work. */
  onOpenWork: (code: string, remoteSourceId: number | null) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const { overview, error: overviewError, reload, markSeen } = rankings;
  const lists = (overview?.lists ?? []).filter((list) => list.enabled);
  const selected = lists.find((list) => list.id === listId) ?? lists[0] ?? null;
  const selectedId = selected?.id ?? null;
  const [page, setPage] = useState<RankingPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<RankingFilter>("all");
  const [droppedOpen, setDroppedOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [watched, setWatched] = useState<Set<string>>(() => new Set());
  const seenSnapshots = useRef(new Set<string>());

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (selectedId === null) return;
      setLoading(true);
      setError("");
      try {
        const next = await api.getRanking(selectedId, compare, signal);
        setPage(next);
        const snapshot = next.snapshot;
        const key = snapshot ? `${selectedId}:${snapshot.id}` : "";
        if (canMarkSeen && !next.demo && snapshot && next.list.unseen && !seenSnapshots.current.has(key)) {
          seenSnapshots.current.add(key);
          await api.markRankingSeen(selectedId, snapshot.id);
          markSeen(selectedId);
        }
      } catch (loadError) {
        if (!signal?.aborted)
          setError(loadError instanceof Error ? loadError.message : t("subscriptions.rankings.loadFailed"));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [canMarkSeen, compare, markSeen, selectedId, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    setFilter("all");
    setDroppedOpen(false);
  }, [selectedId]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.runRankingRefresh(selectedId === null ? undefined : [selectedId]);
      toast.success(t("subscriptions.rankings.refreshQueued"));
    } catch (refreshError) {
      toast.notify(toastFromError(refreshError, t("subscriptions.rankings.refreshFailed")));
    } finally {
      setRefreshing(false);
    }
  };
  const watch = async (code: string) => {
    try {
      await api.addAvailabilityWatchTargets([code]);
      setWatched((current) => new Set(current).add(code));
      toast.success(t("subscriptions.feed.watchAdded", { code }));
    } catch (watchError) {
      toast.notify(toastFromError(watchError, t("subscriptions.feed.watchFailed")));
    }
  };

  if (!overview) {
    return overviewError ? (
      <LoadFailure message={t("subscriptions.rankings.loadFailed")} onRetry={() => void reload()} />
    ) : (
      <Loading label={t("subscriptions.rankings.loading")} />
    );
  }
  if (!selected) {
    return (
      <EmptyState
        title={t("subscriptions.rankings.empty")}
        description={
          canManage && !readOnly ? t("subscriptions.rankings.emptyOperator") : t("subscriptions.rankings.emptyViewer")
        }
        action={
          canManage && !readOnly ? (
            <Button size="sm" variant="outline" onClick={onOpenSettings}>
              <Settings2 className="h-4 w-4" />
              {t("subscriptions.rankings.add")}
            </Button>
          ) : null
        }
      />
    );
  }

  const demo = overview.demo;
  const current = page && page.list.id === selected.id ? page : null;
  const time = (value: string | null | undefined) => {
    const parsed = parseServerTimestamp(value);
    return parsed ? formatDateTime(parsed, resolvedLocale) : "";
  };
  const canRefresh = canManage && !readOnly && !demo;

  const chooser = (
    <div
      role="tablist"
      aria-label={t("subscriptions.rankings.listsLabel")}
      className="-mx-4 flex gap-1.5 overflow-x-auto overflow-y-hidden px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {lists.map((list) => {
        const active = list.id === selected.id;
        return (
          <button
            key={list.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={filterChipClassName(active)}
            onClick={() => onListChange(list.id)}
          >
            {rankingListLabel(list, t)}
            {list.unseen && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-primary" title={t("subscriptions.rankings.unseen")}>
                <span className="sr-only">{t("subscriptions.rankings.unseen")}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  let body: ReactNode;
  if (!current) {
    body = error ? (
      <LoadFailure message={error} onRetry={() => void load()} />
    ) : (
      <Loading label={t("subscriptions.rankings.loading")} />
    );
  } else if (!current.snapshot) {
    body = (
      <EmptyState
        title={t("subscriptions.rankings.waiting")}
        description={t("subscriptions.rankings.waitingDescription")}
        action={
          canRefresh ? (
            <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("subscriptions.rankings.refreshNow")}
            </Button>
          ) : null
        }
      />
    );
  } else {
    body = (
      <RankingSnapshot
        page={current}
        filter={filter}
        droppedOpen={droppedOpen}
        demo={demo}
        canWatch={canWatch && !readOnly}
        watched={watched}
        time={time}
        onFilterChange={setFilter}
        onDroppedOpenChange={setDroppedOpen}
        onCompareChange={onCompareChange}
        onWatch={(code) => void watch(code)}
        onOpenRun={canManage ? onOpenRun : undefined}
        latestRunId={overview.schedule.latestRun?.id}
        onOpenWork={(code) => onOpenWork(code, selected.provider === "remote_source" ? selected.sourceId : null)}
        loading={loading}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {chooser}
        {canRefresh && current?.snapshot && (
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("subscriptions.rankings.refreshNow")}
          </Button>
        )}
      </div>
      {body}
    </div>
  );
}

function RankingSnapshot({
  page,
  filter,
  droppedOpen,
  demo,
  canWatch,
  watched,
  loading,
  time,
  onFilterChange,
  onDroppedOpenChange,
  onCompareChange,
  onWatch,
  onOpenRun,
  latestRunId,
  onOpenWork,
}: {
  page: RankingPage;
  filter: RankingFilter;
  droppedOpen: boolean;
  demo: boolean;
  canWatch: boolean;
  watched: Set<string>;
  loading: boolean;
  time: (value: string | null | undefined) => string;
  onFilterChange: (filter: RankingFilter) => void;
  onDroppedOpenChange: (open: boolean) => void;
  onCompareChange: (compare: string) => void;
  onWatch: (code: string) => void;
  onOpenRun?: (runId: number) => void;
  latestRunId?: number;
  onOpenWork: (code: string) => void;
}) {
  const { t } = useTranslation();
  const list = page.list;
  const counts = rankingFilterCounts(page);
  const items = page.items.filter((item) => matchesRankingFilter(item, filter));
  const now = new Date();
  const baseline = page.baseline;
  const compareValue =
    baseline?.kind === "snapshot" ? String(baseline.id) : baseline?.kind === "previous" ? "previous" : "";
  const compareOptions = [
    { value: "", label: t("subscriptions.rankings.compare.seen") },
    { value: "previous", label: t("subscriptions.rankings.compare.previous") },
    ...page.snapshots.slice(1).map((snapshot) => ({ value: String(snapshot.id), label: time(snapshot.pulledAt) })),
  ];
  const comparedWith = baseline
    ? t(`subscriptions.rankings.comparedWith.${baseline.kind}`, { time: time(baseline.pulledAt) })
    : t("subscriptions.rankings.comparedWith.none");
  const stale = list.lastStatus === "failed" || list.lastStatus === "source_unavailable" ? list.lastStatus : null;

  const row = (item: RankingItem | RankingDroppedItem, meta: ReactNode, rankColumn: ReactNode) => {
    const view = rankingCardView(item, t("workCard.unknownCircle"));
    const footer = demo ? undefined : (
      <WorkCardFooter
        className="h-10 border-border/40"
        left={<WorkCardDLsiteAction href={item.work?.dlsiteUrl || item.fallback.dlsiteUrl} />}
        right={
          <>
            {canWatch && (
              <WorkCardActionButton
                title={t("subscriptions.feed.watch")}
                disabled={watched.has(item.code)}
                onClick={(clickEvent) => {
                  clickEvent.stopPropagation();
                  onWatch(item.code);
                }}
              >
                <Eye className="h-4 w-4" />
              </WorkCardActionButton>
            )}
            {item.work && <WorkCardListButton workId={item.work.id} active={item.work.favorite} />}
          </>
        }
      />
    );
    return (
      <li key={item.code} aria-label={view.title} className="flex min-w-0 gap-2 sm:gap-3">
        <div className="flex w-10 shrink-0 flex-col items-center gap-1 pt-7 sm:w-12">{rankColumn}</div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">{meta}</div>
          <CompactWorkCardShell
            layout="row"
            work={view}
            canOpen={!demo}
            onOpen={() => onOpenWork(item.code)}
            onCircleOpen={demo ? undefined : (externalId: string) => openCircleRoute(externalId)}
            footer={footer}
          />
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-4" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5 text-sm">
          <p className="font-medium">{t("subscriptions.rankings.updated", { time: time(page.snapshot?.pulledAt) })}</p>
          <p className="text-xs text-muted-foreground">{comparedWith}</p>
        </div>
        {page.snapshots.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("subscriptions.rankings.compareWith")}
            <FloatingSelect
              value={compareValue}
              options={compareOptions}
              ariaLabel={t("subscriptions.rankings.compareWith")}
              onValueChange={onCompareChange}
              className="w-48"
            />
          </label>
        )}
      </div>
      {stale && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground"
          role="status"
        >
          <span>{t(`subscriptions.rankings.stale.${stale}`, { time: time(page.snapshot?.pulledAt) })}</span>
          {onOpenRun && latestRunId && (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpenRun(latestRunId)}>
              {t("subscriptions.rankings.viewRun")}
            </button>
          )}
        </div>
      )}
      <div
        role="group"
        aria-label={t("subscriptions.rankings.filtersLabel")}
        className="-mx-4 flex gap-1.5 overflow-x-auto overflow-y-hidden px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {RANKING_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            className={filterChipClassName(filter === option)}
            onClick={() => onFilterChange(option)}
          >
            {t(`subscriptions.rankings.filters.${option}`)}
            <span className="tabular-nums opacity-80">{counts[option]}</span>
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("subscriptions.rankings.noMatches")}</p>
      ) : (
        <ol className="grid gap-3 sm:gap-4 xl:grid-cols-2 2xl:grid-cols-3">
          {items.map((item) =>
            row(
              item,
              <>
                <span className="truncate">
                  {t("subscriptions.rankings.streak", { count: rankingStreakDays(item, now) })}
                  {" · "}
                  {t("subscriptions.rankings.bestRank", { rank: item.bestRank })}
                </span>
                {!item.work && (
                  <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                    {t("subscriptions.rankings.notInLibrary")}
                  </Badge>
                )}
              </>,
              <>
                <span
                  className="text-xl font-semibold leading-6 tabular-nums"
                  aria-label={t("subscriptions.rankings.rank", { rank: item.rank })}
                >
                  {item.rank}
                </span>
                <RankingChangeMarker change={item.change} />
              </>,
            ),
          )}
        </ol>
      )}
      {page.dropped.length > 0 && (
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
            <ol className="grid gap-3 sm:gap-4 xl:grid-cols-2 2xl:grid-cols-3">
              {page.dropped.map((item) =>
                row(
                  item,
                  <span className="truncate">
                    {t("subscriptions.rankings.previousRank", { rank: item.previousRank })}
                  </span>,
                  <span className="text-base font-medium leading-6 text-muted-foreground tabular-nums">—</span>,
                ),
              )}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

/** Movement against the baseline: NEW and Back use the accent, arrows stay neutral. */
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
  if (change.kind === "same") {
    return (
      <span className="text-xs text-muted-foreground" title={t("subscriptions.rankings.change.same")}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("subscriptions.rankings.change.same")}</span>
      </span>
    );
  }
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

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-lg border border-error-border bg-error-surface p-4 text-sm" role="alert">
      <p className="text-error-foreground">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}

function EmptyState({ title, description, action }: { title: string; description: string; action: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <ListOrdered className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

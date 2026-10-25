import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  History,
  ListOrdered,
  Loader2,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Input } from "@/components/ui/input";
import { filterChipClassName, segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
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
import { useLocale } from "@/i18n/LocaleProvider";
import {
  api,
  type RankingChange,
  type RankingDroppedItem,
  type RankingItem,
  type RankingList,
  type RankingOrder,
  type RankingPage,
  type RankingSnapshotRef,
  type RankingVariant,
} from "@/lib/api";
import { openCircleRoute } from "@/lib/circleNavigationState";
import { parseServerTimestamp } from "@/lib/serverTimestamp";
import { cn } from "@/lib/tailwindClassNames";

import {
  ARCHIVE_RANKING_FILTERS,
  formatRankingTime,
  matchesRankingFilter,
  RANKING_FILTERS,
  rankingChipLabel,
  rankingChipOrder,
  rankingChips,
  rankingChipUnseen,
  rankingDayAt,
  rankingDayIsDailyOnly,
  rankingFilterCounts,
  rankingInstant,
  rankingOffersReleaseWindow,
  rankingOffersSalesOrder,
  rankingOrderFor,
  rankingStreakDays,
  rankingVariantFor,
  zonedDay,
  zonedDayRange,
  zonedWallTime,
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
 * last visit by default, the previous update, or another time. A DLsite
 * ranking shows one of its orders: all works or those released within 30
 * days, by popularity or by sales; each order keeps its own history and seen
 * state. History shows the order in effect at a chosen time, compared with the
 * update before it, and never records the ranking as seen. Entries are codes;
 * one without a library work shows the ranking's own text.
 */
export function RankingsView({
  rankings,
  listId,
  at,
  compare,
  order,
  orderPreferences,
  readOnly,
  canManage,
  canMarkSeen,
  canWatch,
  onListChange,
  onOrderChange,
  onAtChange,
  onCompareChange,
  onOpenSettings,
  onOpenRun,
  onOpenWork,
}: {
  rankings: RankingOverviewState;
  /** The list named in the location, or null for the first one. */
  listId: number | null;
  /** The history time named in the location, as an ISO instant, or null for the latest order. */
  at: string | null;
  /** "" for the default, "previous", a snapshot id, or an ISO time. */
  compare: string;
  /** The order named in the location, or null for the one last chosen on the chip. */
  order: RankingOrder | null;
  /** The order last chosen on each chip. */
  orderPreferences: Readonly<Record<string, RankingOrder>>;
  readOnly: boolean;
  /** `metadata:sync`: rankings may be configured and refreshed. */
  canManage: boolean;
  /** Opening the latest order records it as seen; Demo keeps its sample state. */
  canMarkSeen: boolean;
  /** The account may add works to Availability Watch. */
  canWatch: boolean;
  onListChange: (listId: number) => void;
  onOrderChange: (chipKey: string, order: RankingOrder) => void;
  onAtChange: (at: string | null) => void;
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
  const chips = rankingChips(lists);
  const selected = lists.find((list) => list.id === listId) ?? chips[0]?.lists[0] ?? null;
  const selectedId = selected?.id ?? null;
  const selectedChip = chips.find((chip) => chip.lists.some((list) => list.id === selectedId)) ?? null;
  const shown = { chipKey: selectedChip?.key ?? null, order };
  const shownOrder =
    selected && selectedChip
      ? rankingOrderFor(selected, rankingChipOrder(selectedChip, shown, orderPreferences))
      : null;
  const releaseWindow = shownOrder?.releaseWindow ?? "";
  const sort = shownOrder?.sort ?? "";
  const [page, setPage] = useState<RankingPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<RankingFilter>("all");
  const [droppedOpen, setDroppedOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(at !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [watched, setWatched] = useState<Set<string>>(() => new Set());
  const seenSnapshots = useRef(new Set<string>());

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (selectedId === null) return;
      setLoading(true);
      setError("");
      try {
        const next = await api.getRanking(selectedId, { at: at ?? undefined, compare, releaseWindow, sort }, signal);
        setPage(next);
        // Only the latest order counts as seen; looking at history does not.
        const snapshot = next.snapshot;
        const key = snapshot ? `${selectedId}:${snapshot.id}` : "";
        if (canMarkSeen && !next.demo && !at && snapshot && next.variant.unseen && !seenSnapshots.current.has(key)) {
          seenSnapshots.current.add(key);
          await api.markRankingSeen(selectedId, snapshot.id);
          markSeen(selectedId, next.variant.id);
        }
      } catch (loadError) {
        if (!signal?.aborted)
          setError(loadError instanceof Error ? loadError.message : t("subscriptions.rankings.loadFailed"));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [at, canMarkSeen, compare, markSeen, releaseWindow, selectedId, sort, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    setFilter("all");
    setDroppedOpen(false);
  }, [releaseWindow, selectedId, sort]);

  useEffect(() => {
    if (at !== null) setHistoryOpen(true);
  }, [at]);

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
  const timeZone = overview.timeZone || "UTC";
  const variant = rankingVariantFor(selected, shownOrder ?? { releaseWindow, sort });
  const current = page && page.list.id === selected.id && page.variant.id === variant?.id ? page : null;
  const time = (value: string | null | undefined) => formatRankingTime(value, resolvedLocale, timeZone);
  const canRefresh = canManage && !readOnly && !demo && selected.sourceAvailable;
  const latestRunId = overview.workflows.find(
    (workflow) =>
      workflow.code ===
      (selected.provider === "remote_source" ? "remote_popular_collection" : "dlsite_popular_collection"),
  )?.latestRun?.id;
  const closeHistory = () => {
    setHistoryOpen(false);
    if (at !== null) onAtChange(null);
  };

  const chooser = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div
        role="tablist"
        aria-label={t("subscriptions.rankings.listsLabel")}
        className="-mx-4 flex gap-1.5 overflow-x-auto overflow-y-hidden px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {chips.map((chip) => {
          const active = chip === selectedChip;
          return (
            <button
              key={chip.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={filterChipClassName(active)}
              onClick={() => onListChange(chip.lists[0].id)}
            >
              {rankingChipLabel(chip, t)}
              {rankingChipUnseen(chip, rankingChipOrder(chip, shown, orderPreferences)) && (
                <span className="h-2 w-2 shrink-0 rounded-full bg-primary" title={t("subscriptions.rankings.unseen")}>
                  <span className="sr-only">{t("subscriptions.rankings.unseen")}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      {selectedChip?.key === "annual" && selectedChip.lists.length > 1 && (
        <FloatingSelect
          value={String(selected.id)}
          options={selectedChip.lists.map((list) => ({ value: String(list.id), label: String(list.year) }))}
          ariaLabel={t("subscriptions.rankings.year")}
          onValueChange={(value) => onListChange(Number(value))}
          className="w-24"
        />
      )}
    </div>
  );
  const orderControls = selectedChip && (rankingOffersSalesOrder(selected) || rankingOffersReleaseWindow(selected)) && (
    <RankingOrderControls
      list={selected}
      order={{ releaseWindow, sort }}
      onOrderChange={(next) => onOrderChange(selectedChip.key, next)}
    />
  );

  let body: ReactNode;
  if (!current) {
    body = error ? (
      <LoadFailure message={error} onRetry={() => void load()} />
    ) : (
      <Loading label={t("subscriptions.rankings.loading")} />
    );
  } else if (!current.snapshot && !current.at) {
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
        timeZone={timeZone}
        compare={compare}
        onFilterChange={setFilter}
        onDroppedOpenChange={setDroppedOpen}
        onCompareChange={onCompareChange}
        onWatch={(code) => void watch(code)}
        onOpenRun={canManage ? onOpenRun : undefined}
        latestRunId={latestRunId}
        onOpenWork={(code) => onOpenWork(code, selected.provider === "remote_source" ? selected.sourceId : null)}
        loading={loading}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {chooser}
        <div className="flex items-center gap-1">
          {current?.history.firstPulledAt && (
            <Button
              size="sm"
              variant={historyOpen ? "secondary" : "ghost"}
              aria-pressed={historyOpen}
              onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
            >
              <History className="h-4 w-4" />
              {t("subscriptions.rankings.history.open")}
            </Button>
          )}
          {canRefresh && current?.snapshot && !at && (
            <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("subscriptions.rankings.refreshNow")}
            </Button>
          )}
        </div>
      </div>
      {orderControls}
      {historyOpen && current && variant && (
        <RankingHistoryBar
          key={`${selected.id}:${variant.id}`}
          list={selected}
          variant={variant}
          page={current}
          at={at}
          timeZone={timeZone}
          time={time}
          onAtChange={onAtChange}
          onClose={closeHistory}
        />
      )}
      {body}
    </div>
  );
}

/**
 * Chooses the order a DLsite ranking shows: the 30-day window where the
 * period offers it, and popularity or sales. These choose the list itself;
 * the filters below only narrow the shown order's items.
 */
function RankingOrderControls({
  list,
  order,
  onOrderChange,
}: {
  list: RankingList;
  order: RankingOrder;
  onOrderChange: (order: RankingOrder) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {rankingOffersSalesOrder(list) && (
        <div
          role="radiogroup"
          aria-label={t("subscriptions.rankings.order.sortLabel")}
          className={segmentedListClassName()}
        >
          {(["", "sale"] as const).map((value) => (
            <button
              key={value || "popularity"}
              type="button"
              role="radio"
              aria-checked={order.sort === value}
              className={segmentedItemClassName(order.sort === value, "h-7 px-2.5 text-xs")}
              onClick={() => order.sort !== value && onOrderChange({ ...order, sort: value })}
            >
              {t(value ? "subscriptions.rankings.order.sales" : "subscriptions.rankings.order.popularity")}
            </button>
          ))}
        </div>
      )}
      {rankingOffersReleaseWindow(list) && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={order.releaseWindow === "30d"}
            aria-label={t("subscriptions.rankings.order.releaseWindow")}
            onCheckedChange={(checked) => onOrderChange({ ...order, releaseWindow: checked ? "30d" : "" })}
          />
          {t("subscriptions.rankings.order.releaseWindow")}
        </label>
      )}
    </div>
  );
}

/**
 * Chooses a time in a ranking's history: a day in the account's time zone,
 * that day's updates, and the update before or after the one shown.
 */
function RankingHistoryBar({
  list,
  variant,
  page,
  at,
  timeZone,
  time,
  onAtChange,
  onClose,
}: {
  list: RankingList;
  variant: RankingVariant;
  page: RankingPage;
  at: string | null;
  timeZone: string;
  time: (value: string | null | undefined) => string;
  onAtChange: (at: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const now = Date.now();
  const today = zonedDay(now, timeZone);
  const shownTime = at ? Date.parse(at) : (parseServerTimestamp(page.snapshot?.pulledAt)?.getTime() ?? now);
  const day = zonedDay(shownTime, timeZone);
  const first = parseServerTimestamp(page.history.firstPulledAt);
  const firstDay = first ? zonedDay(first.getTime(), timeZone) : today;
  const [updates, setUpdates] = useState<RankingSnapshotRef[]>([]);
  const [more, setMore] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const range = zonedDayRange(day, timeZone);
    api
      .listRankingSnapshots(
        list.id,
        {
          from: new Date(range.start).toISOString(),
          to: new Date(range.end).toISOString(),
          releaseWindow: variant.releaseWindow,
          sort: variant.sort,
        },
        controller.signal,
      )
      .then((timeline) => {
        setUpdates(timeline.snapshots);
        setMore(timeline.nextAfterId);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUpdates([]);
      });
    return () => controller.abort();
  }, [day, list.id, timeZone, variant.releaseWindow, variant.sort]);

  const loadMore = async () => {
    if (more === null) return;
    const range = zonedDayRange(day, timeZone);
    const timeline = await api.listRankingSnapshots(list.id, {
      to: new Date(range.end).toISOString(),
      afterId: more,
      releaseWindow: variant.releaseWindow,
      sort: variant.sort,
    });
    setUpdates((current) => [...current, ...timeline.snapshots]);
    setMore(timeline.nextAfterId);
  };
  const go = (snapshot: RankingSnapshotRef | null) => snapshot && onAtChange(rankingInstant(snapshot.pulledAt));
  const coverage = page.coverage;
  const notes: string[] = [];
  if (at && page.snapshot) {
    notes.push(
      t("subscriptions.rankings.history.pulled", {
        pulled: time(page.snapshot.pulledAt),
        confirmed: time(page.snapshot.confirmedUntil),
      }),
    );
  }
  if (coverage?.state === "unpulled") {
    notes.push(t("subscriptions.rankings.history.unpulled", { confirmed: time(coverage.confirmedUntil) }));
  }
  if (coverage?.state === "before") {
    notes.push(t("subscriptions.rankings.history.before", { time: time(page.history.firstPulledAt) }));
  }
  if (rankingDayIsDailyOnly(day, timeZone, page.history.fullFrom))
    notes.push(t("subscriptions.rankings.history.dailyOnly"));

  return (
    <section
      className="space-y-3 rounded-lg border bg-card p-3 text-sm"
      aria-label={t("subscriptions.rankings.history.label")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t("subscriptions.rankings.history.date")}
          <Input
            type="date"
            value={day}
            min={firstDay}
            max={today}
            className="h-8 w-40"
            onChange={(event) => {
              const next = event.target.value;
              if (next) onAtChange(rankingDayAt(next, timeZone, Date.now()));
            }}
          />
        </label>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={!page.previousSnapshot} onClick={() => go(page.previousSnapshot)}>
            <ChevronLeft className="h-4 w-4" />
            {t("subscriptions.rankings.history.previous")}
          </Button>
          <Button size="sm" variant="ghost" disabled={!page.nextSnapshot} onClick={() => go(page.nextSnapshot)}>
            {t("subscriptions.rankings.history.next")}
            <ChevronRight className="h-4 w-4" />
          </Button>
          {at && (
            <Button size="sm" variant="ghost" onClick={() => onAtChange(null)}>
              {t("subscriptions.rankings.history.latest")}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("subscriptions.rankings.history.close")}
            title={t("subscriptions.rankings.history.close")}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        role="group"
        aria-label={t("subscriptions.rankings.history.updates")}
        className="flex flex-wrap items-center gap-1.5"
      >
        {updates.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("subscriptions.rankings.history.noUpdates")}</span>
        ) : (
          updates.map((update) => (
            <button
              key={update.id}
              type="button"
              aria-pressed={page.snapshot?.id === update.id}
              className={filterChipClassName(page.snapshot?.id === update.id)}
              onClick={() => go(update)}
            >
              {formatRankingTime(update.pulledAt, resolvedLocale, timeZone, "time")}
            </button>
          ))
        )}
        {more !== null && (
          <Button size="sm" variant="ghost" onClick={() => void loadMore()}>
            {t("subscriptions.rankings.history.more")}
          </Button>
        )}
      </div>
      <div className="space-y-0.5 text-xs text-muted-foreground" role="status">
        {notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
        <p>{t("subscriptions.rankings.history.timeZone", { zone: timeZone })}</p>
      </div>
    </section>
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
  timeZone,
  compare,
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
  timeZone: string;
  compare: string;
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
  // A finished annual ranking is an archive: ranks without movement.
  const archive = list.finalAt !== null;
  const history = page.at !== null;
  const counts = rankingFilterCounts(page);
  const filters: readonly RankingFilter[] = archive ? ARCHIVE_RANKING_FILTERS : RANKING_FILTERS;
  const items = page.items.filter((item) => matchesRankingFilter(item, filters.includes(filter) ? filter : "all"));
  const now = new Date();
  const baseline = page.baseline;
  const timedCompare = compare.includes("T");
  const [choosingTime, setChoosingTime] = useState(timedCompare);
  const compareValue = timedCompare || choosingTime ? "time" : compare === "previous" ? "previous" : "";
  const compareOptions = [
    { value: "", label: t(history ? "subscriptions.rankings.compare.before" : "subscriptions.rankings.compare.seen") },
    ...(history ? [] : [{ value: "previous", label: t("subscriptions.rankings.compare.previous") }]),
    { value: "time", label: t("subscriptions.rankings.compare.time") },
  ];
  const comparedWith = baseline
    ? t(`subscriptions.rankings.comparedWith.${baseline.kind}`, { time: time(baseline.pulledAt) })
    : t("subscriptions.rankings.comparedWith.none");
  const lastStatus = page.variant.lastStatus;
  const stale = !history
    ? !list.sourceAvailable
      ? "source_unavailable"
      : lastStatus === "failed" || lastStatus === "source_unavailable"
        ? lastStatus
        : null
    : null;

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

  if (!page.snapshot) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" aria-busy={loading}>
        {t("subscriptions.rankings.history.empty")}
      </p>
    );
  }

  return (
    <div className="space-y-4" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5 text-sm">
          <p className="font-medium">
            {archive
              ? t("subscriptions.rankings.archive", { year: list.year, time: time(list.finalAt) })
              : history
                ? t("subscriptions.rankings.history.showing", { time: time(page.at) })
                : t("subscriptions.rankings.updated", { time: time(page.snapshot.pulledAt) })}
          </p>
          {!archive && <p className="text-xs text-muted-foreground">{comparedWith}</p>}
        </div>
        {!archive && (page.previousSnapshot || baseline) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-2">
              {t("subscriptions.rankings.compareWith")}
              <FloatingSelect
                value={compareValue}
                options={compareOptions}
                ariaLabel={t("subscriptions.rankings.compareWith")}
                onValueChange={(value) => {
                  setChoosingTime(value === "time");
                  if (value !== "time") onCompareChange(value);
                }}
                className="w-44"
              />
            </label>
            {compareValue === "time" && (
              <Input
                type="datetime-local"
                aria-label={t("subscriptions.rankings.compareTime")}
                className="h-8 w-52"
                onChange={(event) => {
                  const instant = zonedWallTime(event.target.value, timeZone);
                  if (instant) onCompareChange(instant);
                }}
              />
            )}
          </div>
        )}
      </div>
      {stale && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground"
          role="status"
        >
          <span>{t(`subscriptions.rankings.stale.${stale}`, { time: time(page.snapshot.pulledAt) })}</span>
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
        {filters.map((option) => (
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
                {!archive && !history && (
                  <span className="truncate">
                    {t("subscriptions.rankings.streak", { count: rankingStreakDays(item, now) })}
                    {" · "}
                    {t("subscriptions.rankings.bestRank", { rank: item.bestRank })}
                  </span>
                )}
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
                {!archive && <RankingChangeMarker change={item.change} />}
              </>,
            ),
          )}
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

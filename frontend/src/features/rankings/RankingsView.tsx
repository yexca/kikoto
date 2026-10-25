import { ListOrdered, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { ShownWorksActionMenu, ShownWorksActionStatus } from "@/components/work-collection/ShownWorksActions";
import { useShownWorksActions } from "@/hooks/useShownWorksActions";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type RankingOrder, type RankingPage } from "@/lib/api";

import { RankingEntryList } from "./RankingEntryList";
import { RankingHistoryPopover } from "./RankingHistoryPopover";
import { RankingStatusPopover } from "./RankingStatusPopover";
import {
  RankingChooser,
  RankingFilterControl,
  RankingHistoryBanner,
  RankingOrderControls,
  RankingToolbar,
} from "./RankingToolbar";
import {
  ARCHIVE_RANKING_FILTERS,
  formatRankingTime,
  RANKING_FILTERS,
  rankingChipGroups,
  rankingChipOrder,
  rankingChips,
  rankingChipUnseen,
  rankingFilterCounts,
  rankingOffersReleaseWindow,
  rankingOffersSalesOrder,
  rankingOrderFor,
  rankingVariantFor,
  type RankingFilter,
} from "./rankingModel";
import type { RankingOverviewState } from "./useRankingOverview";

/**
 * One tracked ranking's latest order compared with a baseline: the account's
 * last visit by default, the previous update, or another time. A DLsite
 * ranking shows one of its orders: all works or those released within 30
 * days, by popularity or by sales; each order keeps its own history and seen
 * state. History shows the order in effect at a chosen time, compared with the
 * update before it, and never records the ranking as seen. Entries are codes;
 * one without a library work shows the ranking's own text. On request, the
 * shown order's metadata is synced, which adds the works the library does not
 * know yet, and the remote sources are asked which entries they have.
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
  canCheckSources,
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
  /** `remote:track`: the remote sources may be asked about the shown entries. */
  canCheckSources: boolean;
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
  const [refreshing, setRefreshing] = useState(false);
  const [watched, setWatched] = useState<Set<string>>(() => new Set());
  const [watching, setWatching] = useState<Set<string>>(() => new Set());
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

  const actions = useShownWorksActions({ onSettled: () => void load(), onOpenRun });

  useEffect(() => {
    setFilter("all");
    setDroppedOpen(false);
  }, [releaseWindow, selectedId, sort]);

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
    setWatching((current) => new Set(current).add(code));
    try {
      await api.addAvailabilityWatchTargets([code]);
      setWatched((current) => new Set(current).add(code));
      toast.success(t("subscriptions.feed.watchAdded", { code }));
    } catch (watchError) {
      toast.notify(toastFromError(watchError, t("subscriptions.feed.watchFailed")));
    } finally {
      setWatching((current) => {
        const next = new Set(current);
        next.delete(code);
        return next;
      });
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
  const archive = selected.finalAt !== null;
  const filters: readonly RankingFilter[] = archive ? ARCHIVE_RANKING_FILTERS : RANKING_FILTERS;
  const recorded = current?.snapshot ? current : null;
  const refreshButton = (label: boolean) => (
    <Button
      size={label ? "sm" : "icon-sm"}
      variant={label ? "outline" : "ghost"}
      disabled={refreshing}
      aria-label={label ? undefined : t("subscriptions.rankings.refreshNow")}
      title={label ? undefined : t("subscriptions.rankings.refreshNow")}
      onClick={() => void refresh()}
    >
      {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      {label && t("subscriptions.rankings.refreshNow")}
    </Button>
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
        action={canRefresh ? refreshButton(true) : null}
      />
    );
  } else if (!current.snapshot) {
    body = (
      <p className="py-8 text-center text-sm text-muted-foreground" aria-busy={loading}>
        {t("subscriptions.rankings.history.empty")}
      </p>
    );
  } else {
    body = (
      <div aria-busy={loading}>
        <RankingEntryList
          page={current}
          filter={filter}
          filters={filters}
          droppedOpen={droppedOpen}
          demo={demo}
          canWatch={canWatch && !readOnly}
          watched={watched}
          watching={watching}
          sourceCheck={actions.sourceCheck}
          onDroppedOpenChange={setDroppedOpen}
          onWatch={(code) => void watch(code)}
          onOpenWork={(code) => onOpenWork(code, selected.provider === "remote_source" ? selected.sourceId : null)}
        />
      </div>
    );
  }

  const shownSnapshot = recorded?.snapshot ?? null;
  const editable = !readOnly && !demo && shownSnapshot !== null;
  const actionRequests = shownSnapshot
    ? {
        ...(canManage && editable ? { metadata: () => api.syncRankingMetadata(selected.id, shownSnapshot.id) } : {}),
        ...(canCheckSources && editable
          ? { sources: () => api.checkRankingSources(selected.id, shownSnapshot.id) }
          : {}),
      }
    : {};

  const lastStatus = current?.variant.lastStatus;
  const stale =
    recorded && !current?.at
      ? !selected.sourceAvailable
        ? "source_unavailable"
        : lastStatus === "failed" || lastStatus === "source_unavailable"
          ? lastStatus
          : null
      : null;

  return (
    <div className="space-y-3">
      <RankingToolbar
        chooser={
          <RankingChooser
            groups={rankingChipGroups(chips, t)}
            selectedChip={selectedChip}
            selectedList={selected}
            unseen={(chip) => rankingChipUnseen(chip, rankingChipOrder(chip, shown, orderPreferences))}
            onListChange={onListChange}
          />
        }
        tools={
          <>
            {current?.history.firstPulledAt && variant && (
              <RankingHistoryPopover
                list={selected}
                variant={variant}
                page={current}
                at={at}
                timeZone={timeZone}
                onAtChange={onAtChange}
              />
            )}
            {canRefresh && current?.snapshot && !at && refreshButton(false)}
            <ShownWorksActionMenu actions={actions} requests={actionRequests} />
          </>
        }
        order={
          selectedChip &&
          (rankingOffersSalesOrder(selected) || rankingOffersReleaseWindow(selected)) && (
            <RankingOrderControls
              list={selected}
              order={{ releaseWindow, sort }}
              onOrderChange={(next) => onOrderChange(selectedChip.key, next)}
            />
          )
        }
        filters={
          recorded && (
            <RankingFilterControl
              filters={filters}
              filter={filter}
              counts={rankingFilterCounts(recorded, actions.sourceCheck)}
              onFilterChange={setFilter}
            />
          )
        }
        status={
          recorded && (
            <RankingStatusPopover
              page={recorded}
              compare={compare}
              timeZone={timeZone}
              onCompareChange={onCompareChange}
            />
          )
        }
        banner={
          at && current ? (
            <RankingHistoryBanner
              label={t("subscriptions.rankings.history.showing", { time: time(current.at ?? at) })}
              onLatest={() => onAtChange(null)}
            />
          ) : null
        }
      />
      {stale && recorded?.snapshot && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warning-border bg-warning-surface px-3 py-1.5 text-xs text-warning-foreground"
          role="status"
        >
          <span>{t(`subscriptions.rankings.stale.${stale}`, { time: time(recorded.snapshot.pulledAt) })}</span>
          {canManage && latestRunId && (
            <button
              type="button"
              className="font-medium underline-offset-2 hover:underline"
              onClick={() => onOpenRun(latestRunId)}
            >
              {t("subscriptions.rankings.viewRun")}
            </button>
          )}
        </div>
      )}
      <ShownWorksActionStatus actions={actions} onOpenRun={onOpenRun} />
      {body}
    </div>
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

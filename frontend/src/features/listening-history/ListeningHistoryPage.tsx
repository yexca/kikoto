import { CalendarDays, Clock, Disc3, History, Loader2, PlayCircle, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { CollectionPagination } from "@/components/collection/CollectionPagination";
import { SettingsDisclosure } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import { dateTimeFormat, formatNumber } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { announceListeningHistoryCleared } from "@/lib/listeningHistoryEvents";
import {
  listeningApi,
  type ListeningHistoryPage as ListeningHistoryResult,
  type ListeningStatistics,
  type ListeningStatisticsRange,
} from "@/lib/listeningApi";
import { parseServerTimestamp } from "@/lib/serverTimestamp";

import { ListeningActivityChart } from "./ListeningActivityChart";
import { LISTENING_HISTORY_PAGE_SIZE, LISTENING_REPORT_RANGES, listeningDurationParts } from "./listeningHistoryModel";
import { ListeningWorkCard, type ListeningHistoryWorkLinkFactory } from "./ListeningWorkCard";

export type { ListeningHistoryWorkLink, ListeningHistoryWorkLinkFactory } from "./ListeningWorkCard";

type LoadState<T> =
  { status: "loading"; data: T | null } | { status: "ready"; data: T } | { status: "error"; data: T | null };

const TOP_WORK_COUNT = 6;

function useDurationFormatter() {
  const { t } = useTranslation();
  return useCallback(
    (seconds: number) => {
      const parts = listeningDurationParts(seconds);
      return t(`personal.duration.${parts.key}`, parts.values);
    },
    [t],
  );
}

/**
 * The listening report for a chosen range (totals, activity, and most
 * listened works) with the full per-work history collapsed below it. The
 * history is a record rather than a summary, so it loads only once opened.
 */
export function ListeningHistoryPage({
  canClear,
  storageScope,
  workLink,
}: {
  canClear: boolean;
  /** Server and principal scope; players in this scope drop unreported pre-clear sessions. */
  storageScope: string;
  workLink: ListeningHistoryWorkLinkFactory;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const formatDuration = useDurationFormatter();
  const [range, setRange] = useState<ListeningStatisticsRange>(LISTENING_REPORT_RANGES[0]);
  const [statistics, setStatistics] = useState<LoadState<ListeningStatistics>>({ status: "loading", data: null });
  const [history, setHistory] = useState<LoadState<ListeningHistoryResult>>({ status: "loading", data: null });
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [statisticsToken, setStatisticsToken] = useState(0);
  const [historyToken, setHistoryToken] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    const next = query.trim();
    if (next === debouncedQuery) return;
    const timer = window.setTimeout(() => {
      setDebouncedQuery(next);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [debouncedQuery, query]);

  useEffect(() => {
    const controller = new AbortController();
    setStatistics((current) => ({ status: "loading", data: current.data }));
    listeningApi
      .statistics(range, controller.signal)
      .then((data) => setStatistics({ status: "ready", data }))
      .catch(() => {
        if (!controller.signal.aborted) setStatistics((current) => ({ status: "error", data: current.data }));
      });
    return () => controller.abort();
  }, [range, statisticsToken]);

  useEffect(() => {
    if (!recordsOpen) return;
    const controller = new AbortController();
    setHistory((current) => ({ status: "loading", data: current.data }));
    listeningApi
      .history({ page, pageSize: LISTENING_HISTORY_PAGE_SIZE, query: debouncedQuery }, controller.signal)
      .then((data) => setHistory({ status: "ready", data }))
      .catch(() => {
        if (!controller.signal.aborted) setHistory((current) => ({ status: "error", data: current.data }));
      });
    return () => controller.abort();
  }, [debouncedQuery, historyToken, page, recordsOpen]);

  const clearHistory = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await listeningApi.clearHistory();
      announceListeningHistoryCleared(storageScope);
      setConfirmClear(false);
      setPage(1);
      setStatisticsToken((value) => value + 1);
      setHistoryToken((value) => value + 1);
      toast.success(t("personal.history.cleared"));
    } catch (error) {
      toast.notify(toastFromError(error, t("personal.history.clearFailed")));
    } finally {
      setClearing(false);
    }
  };

  // Totals are shown only for the range they describe; the previous range stays
  // visible (dimmed) while the next one loads.
  const stats = statistics.data;
  const refreshing = statistics.status === "loading" && stats !== null;
  const historyData = history.data;
  const total = historyData?.total ?? 0;
  const hasHistory = (stats?.listenCount ?? 0) > 0 || (stats?.workCount ?? 0) > 0 || total > 0;
  const topWorks = stats?.topWorks.slice(0, TOP_WORK_COUNT) ?? [];
  const historyCardDetail = (listenedSeconds: number, lastPlayedAt: string) => {
    const duration = formatDuration(listenedSeconds);
    const lastPlayed = parseServerTimestamp(lastPlayedAt);
    if (!lastPlayed) return duration;
    const date = dateTimeFormat(resolvedLocale, { month: "short", day: "numeric" }).format(lastPlayed);
    return t("personal.history.cardDetail", { duration, date });
  };

  return (
    <div className="w-full max-w-4xl space-y-6">
      <section aria-labelledby="listening-summary-heading" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3 px-1">
          <div className="min-w-0">
            <h2 id="listening-summary-heading" className="text-sm font-semibold">
              {t("personal.history.summary")}
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("personal.history.recordingNote")}</p>
          </div>
          {canClear && hasHistory && (
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => setConfirmClear(true)}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {t("personal.history.clear")}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className={segmentedListClassName()} role="group" aria-label={t("personal.history.rangeLabel")}>
            {LISTENING_REPORT_RANGES.map((option) => (
              <button
                key={option}
                type="button"
                className={segmentedItemClassName(range === option)}
                aria-pressed={range === option}
                onClick={() => setRange(option)}
              >
                {t(`personal.history.ranges.${option}`)}
              </button>
            ))}
          </div>
          {range !== "all" && <p className="px-1 text-2xs text-muted-foreground">{t("personal.history.rangeNote")}</p>}
        </div>
        {statistics.status === "error" && (
          <InlineRetry
            message={t("personal.history.statisticsFailed")}
            onRetry={() => setStatisticsToken((value) => value + 1)}
          />
        )}
        <div
          aria-busy={statistics.status === "loading"}
          className={refreshing ? "space-y-3 opacity-60 transition-opacity" : "space-y-3 transition-opacity"}
        >
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Statistic
              icon={<Clock />}
              label={t("personal.history.totalTime")}
              value={stats ? formatDuration(stats.listenedSeconds) : null}
            />
            <Statistic
              icon={<PlayCircle />}
              label={t("personal.history.plays")}
              value={stats ? formatNumber(stats.listenCount, resolvedLocale) : null}
            />
            <Statistic
              icon={<Disc3 />}
              label={t("personal.history.works")}
              value={stats ? formatNumber(stats.workCount, resolvedLocale) : null}
            />
            <Statistic
              icon={<CalendarDays />}
              label={t("personal.history.activeDays")}
              value={stats ? formatNumber(stats.activeDays, resolvedLocale) : null}
            />
          </dl>
          {stats && (
            <div className="theme-card-surface rounded-xl border bg-card p-4">
              <ListeningActivityChart
                key={stats.range}
                series={stats.series}
                granularity={stats.granularity}
                formatDuration={formatDuration}
              />
            </div>
          )}
          {topWorks.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-3 px-1">
                <h3 className="text-sm font-semibold">{t("personal.history.topWorks")}</h3>
                <span className="text-xs text-muted-foreground">{t("personal.history.topWorksBasis")}</span>
              </div>
              <ol
                aria-label={t("personal.history.topWorks")}
                className="app-scrollbar -mx-1 flex snap-x gap-3 overflow-x-auto overflow-y-hidden px-1 pb-1"
              >
                {topWorks.map((item, index) => (
                  <li key={item.workId} className="w-32 shrink-0 snap-start sm:w-auto sm:min-w-0 sm:flex-1 sm:basis-0">
                    <ListeningWorkCard
                      className="h-full"
                      rank={index + 1}
                      item={item}
                      link={workLink(item.primaryCode)}
                      detail={formatDuration(item.listenedSeconds)}
                    />
                  </li>
                ))}
                {Array.from({ length: TOP_WORK_COUNT - topWorks.length }, (_, index) => (
                  <li
                    key={`placeholder-${index}`}
                    aria-hidden="true"
                    className="hidden sm:block sm:flex-1 sm:basis-0"
                  />
                ))}
              </ol>
            </div>
          )}
        </div>
      </section>

      <section
        aria-labelledby="listening-history-heading"
        className="theme-card-surface overflow-hidden rounded-xl border bg-card"
      >
        <SettingsDisclosure
          title={<span id="listening-history-heading">{t("personal.history.recent")}</span>}
          description={t("personal.history.recentHint")}
          open={recordsOpen}
          onToggle={setRecordsOpen}
        >
          {recordsOpen && (
            <div className="space-y-3 p-4">
              <div className="relative w-full sm:w-72">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  className="w-full pl-9 pr-10"
                  value={query}
                  placeholder={t("personal.history.search")}
                  aria-label={t("personal.history.search")}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2"
                    aria-label={t("personal.history.clearSearch")}
                    title={t("personal.history.clearSearch")}
                    onClick={() => setQuery("")}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {history.status === "error" && (
                <InlineRetry
                  message={t("personal.history.loadFailed")}
                  onRetry={() => setHistoryToken((value) => value + 1)}
                />
              )}
              {historyData === null ? (
                history.status === "loading" && (
                  <div className="grid place-items-center py-10 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" aria-label={t("common.loading")} />
                  </div>
                )
              ) : historyData.items.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  <History className="h-5 w-5" aria-hidden="true" />
                  {debouncedQuery ? t("personal.history.noMatch") : t("personal.history.empty")}
                </div>
              ) : (
                <>
                  <CollectionPagination
                    placement="top"
                    page={page}
                    pageSize={LISTENING_HISTORY_PAGE_SIZE}
                    totalItems={total}
                    totalPages={Math.max(1, Math.ceil(total / LISTENING_HISTORY_PAGE_SIZE))}
                    itemLabel={t("personal.history.itemLabel")}
                    ariaLabel={t("personal.history.pages")}
                    refreshing={history.status === "loading"}
                    onPageChange={setPage}
                  />
                  <ul
                    aria-label={t("personal.history.recent")}
                    aria-busy={history.status === "loading"}
                    className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-6"
                  >
                    {historyData.items.map((item) => (
                      <li key={item.workId} className="min-w-0">
                        <ListeningWorkCard
                          className="h-full"
                          item={item}
                          link={workLink(item.primaryCode)}
                          detail={historyCardDetail(item.listenedSeconds, item.lastPlayedAt)}
                        />
                      </li>
                    ))}
                  </ul>
                  <CollectionPagination
                    placement="bottom"
                    page={page}
                    pageSize={LISTENING_HISTORY_PAGE_SIZE}
                    totalItems={total}
                    totalPages={Math.max(1, Math.ceil(total / LISTENING_HISTORY_PAGE_SIZE))}
                    itemLabel={t("personal.history.itemLabel")}
                    ariaLabel={t("personal.history.pages")}
                    onPageChange={setPage}
                  />
                </>
              )}
            </div>
          )}
        </SettingsDisclosure>
      </section>

      {confirmClear && (
        <Dialog
          onClose={() => !clearing && setConfirmClear(false)}
          dismissible={!clearing}
          size="sm"
          role="alertdialog"
        >
          <DialogHeader title={t("personal.history.clearTitle")} description={t("personal.history.clearDescription")} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmClear(false)} disabled={clearing} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void clearHistory()} disabled={clearing}>
              {clearing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t("personal.history.clearConfirm")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function Statistic({ icon, label, value }: { icon: ReactNode; label: string; value: string | null }) {
  return (
    <div className="theme-card-surface flex min-w-0 items-center gap-3 rounded-xl border bg-card px-4 py-3">
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary [&>svg]:h-4 [&>svg]:w-4"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="truncate text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-0.5 truncate text-lg font-semibold tabular-nums">
          {value ?? <span className="inline-block h-5 w-16 animate-pulse rounded bg-muted align-middle" />}
        </dd>
      </div>
    </div>
  );
}

function InlineRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
    >
      <span>{message}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}

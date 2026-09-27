import { History, Loader2, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { CollectionPagination } from "@/components/collection/CollectionPagination";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastFromError, useToast } from "@/components/ui/toast";
import { formatDateTime, formatNumber } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { announceListeningHistoryCleared } from "@/lib/listeningHistoryEvents";
import {
  listeningApi,
  type ListeningHistoryItem,
  type ListeningHistoryPage as ListeningHistoryResult,
  type ListeningStatistics,
} from "@/lib/listeningApi";

import { ListeningDailyChart } from "./ListeningDailyChart";
import { LISTENING_HISTORY_PAGE_SIZE, listeningDurationParts } from "./listeningHistoryModel";

/** A work's detail location and in-app navigation, composed by the app shell. */
export type ListeningHistoryWorkLink = { href: string | undefined; open: () => void };

export type ListeningHistoryWorkLinkFactory = (primaryCode: string) => ListeningHistoryWorkLink;

type LoadState<T> =
  { status: "loading"; data: T | null } | { status: "ready"; data: T } | { status: "error"; data: T | null };

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
  const [statistics, setStatistics] = useState<LoadState<ListeningStatistics>>({ status: "loading", data: null });
  const [history, setHistory] = useState<LoadState<ListeningHistoryResult>>({ status: "loading", data: null });
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
      .statistics(controller.signal)
      .then((data) => setStatistics({ status: "ready", data }))
      .catch(() => {
        if (!controller.signal.aborted) setStatistics((current) => ({ status: "error", data: current.data }));
      });
    return () => controller.abort();
  }, [statisticsToken]);

  useEffect(() => {
    const controller = new AbortController();
    setHistory((current) => ({ status: "loading", data: current.data }));
    listeningApi
      .history({ page, pageSize: LISTENING_HISTORY_PAGE_SIZE, query: debouncedQuery }, controller.signal)
      .then((data) => setHistory({ status: "ready", data }))
      .catch(() => {
        if (!controller.signal.aborted) setHistory((current) => ({ status: "error", data: current.data }));
      });
    return () => controller.abort();
  }, [debouncedQuery, historyToken, page]);

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

  const stats = statistics.data;
  const historyData = history.data;
  const total = historyData?.total ?? 0;
  const hasHistory = (stats?.listenCount ?? 0) > 0 || total > 0;

  return (
    <div className="w-full max-w-4xl space-y-6">
      <section aria-labelledby="listening-summary-heading" className="space-y-3">
        <div className="flex items-end justify-between gap-3 px-1">
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
        {statistics.status === "error" && (
          <InlineRetry
            message={t("personal.history.statisticsFailed")}
            onRetry={() => setStatisticsToken((value) => value + 1)}
          />
        )}
        <div className="theme-card-surface space-y-5 rounded-xl border bg-card p-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Statistic
              label={t("personal.history.totalTime")}
              value={stats ? formatDuration(stats.listenedSeconds) : null}
            />
            <Statistic
              label={t("personal.history.plays")}
              value={stats ? formatNumber(stats.listenCount, resolvedLocale) : null}
            />
            <Statistic
              label={t("personal.history.works")}
              value={stats ? formatNumber(stats.workCount, resolvedLocale) : null}
            />
            <Statistic
              label={t("personal.history.activeDays")}
              value={stats ? formatNumber(stats.activeDays, resolvedLocale) : null}
            />
          </dl>
          {stats && <ListeningDailyChart daily={stats.daily} formatDuration={formatDuration} />}
        </div>
        {stats && stats.topWorks.length > 0 && (
          <div className="space-y-2">
            <h3 className="px-1 text-sm font-semibold">{t("personal.history.topWorks")}</h3>
            <ol className="theme-card-surface divide-y overflow-hidden rounded-xl border bg-card">
              {stats.topWorks.slice(0, 5).map((item) => (
                <HistoryRow
                  key={item.workId}
                  item={item}
                  link={workLink(item.primaryCode)}
                  formatDuration={formatDuration}
                />
              ))}
            </ol>
          </div>
        )}
      </section>

      <section aria-labelledby="listening-history-heading" className="space-y-3">
        <div className="flex flex-col gap-2 px-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="listening-history-heading" className="text-sm font-semibold">
            {t("personal.history.recent")}
          </h2>
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
        </div>
        {history.status === "error" && (
          <InlineRetry
            message={t("personal.history.loadFailed")}
            onRetry={() => setHistoryToken((value) => value + 1)}
          />
        )}
        {historyData === null ? (
          history.status === "loading" && (
            <div className="grid place-items-center rounded-xl border bg-card py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" aria-label={t("common.loading")} />
            </div>
          )
        ) : historyData.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
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
              className="theme-card-surface divide-y overflow-hidden rounded-xl border bg-card"
            >
              {historyData.items.map((item) => (
                <HistoryRow
                  key={item.workId}
                  item={item}
                  link={workLink(item.primaryCode)}
                  formatDuration={formatDuration}
                  lastPlayed={formatDateTime(item.lastPlayedAt, resolvedLocale)}
                />
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

function Statistic({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-lg font-semibold tabular-nums">
        {value ?? <span className="inline-block h-5 w-16 animate-pulse rounded bg-muted align-middle" />}
      </dd>
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

function HistoryRow({
  item,
  link,
  formatDuration,
  lastPlayed,
}: {
  item: ListeningHistoryItem;
  link: ListeningHistoryWorkLink;
  formatDuration: (seconds: number) => string;
  lastPlayed?: string;
}) {
  const { t } = useTranslation();
  const title = item.title || item.primaryCode;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    link.open();
  };
  return (
    <li>
      <a
        href={link.href}
        onClick={open}
        title={t("personal.history.openWork", { title })}
        className="flex min-h-12 items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            <span className="font-mono">{item.primaryCode}</span>
            {lastPlayed && ` · ${t("personal.history.lastPlayed", { date: lastPlayed })}`}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          <span className="block font-medium text-foreground">
            {t("personal.history.listenedFor", { duration: formatDuration(item.listenedSeconds) })}
          </span>
          <span className="block">{t("personal.history.playCount", { count: item.listenCount })}</span>
        </span>
      </a>
    </li>
  );
}

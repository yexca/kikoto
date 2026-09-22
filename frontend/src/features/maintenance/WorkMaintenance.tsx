import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImageOff,
  Inbox,
  RefreshCw,
  Search,
  SearchCheck,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEventHandler, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { formatNumber } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, assetURL, type Work, type MaintenanceWorkPage } from "@/lib/api";
import { currentPageSelection, pageAfterUnlinkedDelete, setCurrentPageSelected } from "./unlinkedWorksModel";

import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { metadataIssueRunFromLocation } from "@/lib/metadataMaintenance";
import { MetadataIssueDetails } from "./MetadataIssueDetails";

function reasonFromLocation() {
  const params = new URLSearchParams(window.location.search);
  if (metadataIssueRunFromLocation()) return "metadata";
  const reason = params.get("reason");
  if (reason === "catalog" || reason === "all" || reason === "metadata" || reason === "no_source") return reason;
  return params.get("tab") === "unlinked" ? "no_source" : "catalog";
}

const PAGE_SIZES = [25, 50] as const;

// Keeps a 44px touch target on phones while drawing the regular 20px box inside it.
const touchCheckboxClassName =
  "max-sm:relative max-sm:h-11 max-sm:w-11 max-sm:border-0 max-sm:bg-transparent max-sm:hover:bg-transparent max-sm:before:absolute max-sm:before:inset-3 max-sm:before:rounded max-sm:before:border max-sm:before:border-input max-sm:before:bg-background max-sm:data-[state=checked]:before:border-primary max-sm:data-[state=checked]:before:bg-primary max-sm:data-[state=indeterminate]:before:border-primary max-sm:data-[state=indeterminate]:before:bg-primary max-sm:[&>svg]:relative";

type PendingDelete = {
  workIds: number[];
  labels: string[];
};

export function WorkMaintenance({
  canManageSources,
  canSyncMetadata,
  readOnly = false,
  actions,
}: {
  canManageSources: boolean;
  canSyncMetadata: boolean;
  readOnly?: boolean;
  actions?: ReactNode;
}) {
  const availableReason = () => {
    const requested = reasonFromLocation();
    if (requested === "metadata" && !canSyncMetadata) return "catalog";
    if (requested === "no_source" && !canManageSources) return "catalog";
    return requested;
  };
  const toast = useToast();
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [result, setResult] = useState<MaintenanceWorkPage>({ works: [], page: 1, pageSize: 25, total: 0 });
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedWorkIds, setSelectedWorkIds] = useState<Set<number>>(() => new Set());
  const [checkingWorkIds, setCheckingWorkIds] = useState<Set<number>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [reason, setReason] = useState(() => availableReason());
  const [runId, setRunId] = useState(metadataIssueRunFromLocation);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const onLocation = () => {
      setReason(availableReason());
      setRunId(metadataIssueRunFromLocation());
      setPage(1);
      setSelectedWorkIds(new Set());
    };
    window.addEventListener("popstate", onLocation);
    window.addEventListener(NAVIGATION_EVENT, onLocation);
    return () => {
      window.removeEventListener("popstate", onLocation);
      window.removeEventListener(NAVIGATION_EVENT, onLocation);
    };
  }, [canManageSources, canSyncMetadata]);

  useEffect(() => {
    setSelectedWorkIds(new Set());
  }, [page, pageSize, query, reason, runId]);

  const tabListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [reason]);

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || controller.signal.aborted) return;
      fetching = true;
      setLoading(true);
      try {
        const next = await api.listMaintenanceWorks(page, pageSize, query, reason, runId, controller.signal);
        if (controller.signal.aborted) return;
        if (next.works.length === 0 && page > 1 && next.total <= (page - 1) * pageSize) {
          setPage(Math.max(1, Math.ceil(next.total / pageSize)));
          return;
        }
        setResult(next);
        setHasLoaded(true);
        setLoadError("");
        const present = new Set(
          next.works
            .filter((work) => canManageSources || work.metadataIssues.some((issue) => !issue.retrying))
            .map((work) => work.id),
        );
        setSelectedWorkIds((current) => new Set([...current].filter((id) => present.has(id))));
      } catch {
        if (!controller.signal.aborted) setLoadError(t("errors.unavailable"));
      } finally {
        fetching = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [page, pageSize, query, reason, runId, refreshKey, canManageSources, t]);

  const pageWorkIds = useMemo(
    () =>
      result.works
        .filter((work) => canManageSources || work.metadataIssues.some((issue) => !issue.retrying))
        .map((work) => work.id),
    [result.works, canManageSources],
  );
  const selection = currentPageSelection(pageWorkIds, selectedWorkIds);
  const selectedWorks = useMemo(
    () => result.works.filter((work) => selectedWorkIds.has(work.id)),
    [result.works, selectedWorkIds],
  );
  const sourceWorks = selectedWorks.filter((work) => work.noSource);
  const retryIds = selectedWorks.flatMap((work) => {
    const item = work.metadataIssues.find((issue) => issue.providerCode === "dlsite" && !issue.retrying);
    return item ? [item.workId] : [];
  });
  const setFilter = (next: string, nextRun: number | null = null) => {
    const params = new URLSearchParams({ reason: next });
    if (nextRun) params.set("metadataRun", String(nextRun));
    window.history.replaceState(window.history.state, "", `/metadata?${params}`);
    setPendingDelete(null);
    setReason(next);
    setRunId(nextRun);
    setPage(1);
    setSelectedWorkIds(new Set());
  };
  const retryMetadata = async (ids: number[]) => {
    if (!canSyncMetadata || readOnly || retrying || loading || ids.length === 0) return;
    setRetrying(true);
    setNotice("");
    try {
      const response = await api.retryMetadataIssues(ids);
      setNotice(t("metadataIssues.retryResult", response));
      setSelectedWorkIds(new Set());
      setRefreshKey((current) => current + 1);
    } catch {
      setNotice(t("metadataIssues.retryFailed"));
    } finally {
      setRetrying(false);
    }
  };
  const navigateWork: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState({}, "", event.currentTarget.getAttribute("href"));
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  const rangeStart = result.total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(result.total, page * pageSize);
  const checking = checkingWorkIds.size > 0;
  const initialLoading = loading && !hasLoaded;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };

  const clearSearch = () => {
    setQueryDraft("");
    setQuery("");
    setPage(1);
  };

  const toggleWork = (workId: number, checked: boolean) => {
    setSelectedWorkIds((current) => {
      const next = new Set(current);
      if (checked) next.add(workId);
      else next.delete(workId);
      return next;
    });
  };

  const checkSources = async (workIds: number[]) => {
    if (workIds.length === 0 || !canManageSources || readOnly || !!loadError || loading || checking || deleting) return;
    setCheckingWorkIds(new Set(workIds));
    try {
      const response = await api.checkUnlinkedWorkSources(workIds);
      setSelectedWorkIds((current) => {
        const next = new Set(current);
        workIds.forEach((workId) => next.delete(workId));
        return next;
      });
      if (response.queued > 0) {
        toast.success(
          `Source check #${response.runId} queued for ${response.queued} ${response.queued === 1 ? "work" : "works"}.`,
        );
      } else {
        toast.warning(t("errors.unavailable"));
        setRefreshKey((current) => current + 1);
      }
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setCheckingWorkIds(new Set());
    }
  };

  const requestDelete = (works: Work[]) => {
    if (
      works.length === 0 ||
      !canManageSources ||
      readOnly ||
      loading ||
      reason !== "no_source" ||
      checking ||
      deleting
    )
      return;
    setPendingDelete({
      workIds: works.map((work) => work.id),
      labels: works.map((work) => `${work.primaryCode} · ${work.title}`),
    });
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      const response = await api.deleteUnlinkedWorks(pendingDelete.workIds, true);
      const nextPage = pageAfterUnlinkedDelete(page, result.total, pageSize, response.deletedFamilyCount);
      setPendingDelete(null);
      setSelectedWorkIds(new Set());
      if (response.deletedFamilyCount > 0) {
        toast.success(
          `Deleted local information for ${response.deletedFamilyCount} ${response.deletedFamilyCount === 1 ? "work family" : "work families"}.`,
        );
      }
      if (response.skipped.length > 0) {
        toast.warning(
          `${response.skipped.length} ${response.skipped.length === 1 ? "work was" : "works were"} skipped because source state changed.`,
        );
      }
      if (nextPage !== page) setPage(nextPage);
      else setRefreshKey((current) => current + 1);
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setDeleting(false);
    }
  };

  const controlsDisabled = readOnly || !!loadError || loading;
  const tabs = [
    ["catalog", "workManagement.all"],
    ["all", "workMaintenance.all"],
    ...(canSyncMetadata ? [["metadata", "workMaintenance.metadata"]] : []),
    ...(canManageSources ? [["no_source", "workMaintenance.noSource"]] : []),
  ];

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={t("workMaintenance.reason")}
          className={segmentedListClassName("min-w-0")}
        >
          {tabs.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={reason === value}
              aria-controls="metadata-records"
              id={`metadata-tab-${value}`}
              className={segmentedItemClassName(reason === value)}
              onClick={() => setFilter(value)}
              onKeyDown={(event) => {
                const tabs = Array.from(
                  event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
                );
                const current = tabs.indexOf(event.currentTarget);
                const next =
                  event.key === "ArrowRight"
                    ? (current + 1) % tabs.length
                    : event.key === "ArrowLeft"
                      ? (current + tabs.length - 1) % tabs.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                tabs[next].focus();
                tabs[next].click();
              }}
              tabIndex={reason === value ? 0 : -1}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 gap-2">{actions}</div>
      </div>
      <section
        id="metadata-records"
        aria-label={t("workMaintenance.title")}
        className="overflow-hidden rounded-lg border bg-card"
      >
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-base font-semibold">
              {reason === "catalog" ? t("workManagement.allMetadata") : t("workManagement.issues")}
            </h2>
            <span className="text-sm tabular-nums text-muted-foreground">
              {formatNumber(result.total, resolvedLocale)}
            </span>
          </div>
          <form className="flex min-w-0 items-center gap-1 sm:w-80" onSubmit={submitSearch}>
            <div className="relative min-w-0 flex-1">
              <button
                type="submit"
                className="absolute left-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground max-sm:h-11 max-sm:w-11"
                aria-label={t("unlinked.search")}
                title={t("unlinked.search")}
              >
                <Search className="h-4 w-4" />
              </button>
              <Input
                type="search"
                maxLength={256}
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
                placeholder={t("unlinked.searchPlaceholder")}
                aria-label={t("workMaintenance.search")}
                fieldSize="sm"
                className="w-full pl-9 pr-9 max-sm:h-11 max-sm:pl-12 [&::-webkit-search-cancel-button]:hidden"
              />
              {queryDraft && (
                <button
                  type="button"
                  className="absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground max-sm:h-9 max-sm:w-9"
                  onClick={clearSearch}
                  aria-label={t("unlinked.clearSearch")}
                  title={t("unlinked.clearSearch")}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="shrink-0 text-muted-foreground max-sm:h-11 max-sm:w-11"
              onClick={() => setRefreshKey((current) => current + 1)}
              disabled={loading}
              aria-label={t("unlinked.refresh")}
              title={t("unlinked.refresh")}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </form>
        </div>

        {runId && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-info-border bg-info-surface px-4 py-1.5 text-sm text-info-foreground">
            <span>{t("metadataIssues.runFilter", { id: runId })}</span>
            <Button size="sm" variant="ghost" onClick={() => setFilter("all")}>
              {t("metadataIssues.showAll")}
            </Button>
          </div>
        )}
        <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 border-y bg-muted/30 px-4 py-1.5 max-sm:pl-1.5">
          <Checkbox
            checked={selection.checked}
            indeterminate={selection.indeterminate}
            onCheckedChange={(checked) =>
              setSelectedWorkIds((current) => setCurrentPageSelected(pageWorkIds, current, checked))
            }
            className={touchCheckboxClassName}
            disabled={controlsDisabled || pageWorkIds.length === 0 || checking || deleting}
            aria-label={t("unlinked.selectPage")}
          />
          <span className="mr-auto text-xs tabular-nums text-muted-foreground sm:ml-2">
            {selection.selectedCount > 0
              ? t("unlinked.selected", { count: selection.selectedCount })
              : t("unlinked.range", {
                  first: rangeStart,
                  last: rangeEnd,
                  total: formatNumber(result.total, resolvedLocale),
                })}
          </span>
          {canSyncMetadata && (
            <Button
              size="sm"
              variant={retryIds.length > 0 ? "default" : "ghost"}
              title={t("workMaintenance.retrySelected", { count: retryIds.length })}
              onClick={() => void retryMetadata(retryIds)}
              disabled={controlsDisabled || retrying || retryIds.length === 0}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />
              <BulkLabel
                label={t("workMaintenance.retrySelected", { count: retryIds.length })}
                count={retryIds.length}
              />
            </Button>
          )}
          {canManageSources && (
            <Button
              size="sm"
              variant={sourceWorks.length > 0 ? "outline" : "ghost"}
              title={t("workMaintenance.checkSources", { count: sourceWorks.length })}
              onClick={() => void checkSources(sourceWorks.map((work) => work.id))}
              disabled={sourceWorks.length === 0 || controlsDisabled || checking || deleting}
            >
              <SearchCheck className={`h-3.5 w-3.5 ${checking ? "animate-pulse" : ""}`} />
              <BulkLabel
                label={t("workMaintenance.checkSources", { count: sourceWorks.length })}
                count={sourceWorks.length}
              />
            </Button>
          )}
          {canManageSources && reason === "no_source" && (
            <Button
              size="sm"
              variant="ghost"
              className="hover:bg-error-surface hover:text-error-foreground"
              title={t("unlinked.deleteInfo")}
              onClick={() => requestDelete(sourceWorks)}
              disabled={sourceWorks.length === 0 || controlsDisabled || checking || deleting}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="max-sm:sr-only">{t("unlinked.deleteInfo")}</span>
            </Button>
          )}
        </div>

        {notice && (
          <p role="status" className="border-b px-4 py-2 text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        <div className="min-h-64">
          {loadError && hasLoaded && (
            <div
              className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-error-border bg-error-surface px-4 py-2"
              role="alert"
            >
              <span className="text-sm text-error-foreground">
                {loadError} {t("unlinked.existingResultsShown")}
              </span>
              <Button size="sm" variant="outline" onClick={() => setRefreshKey((current) => current + 1)}>
                {t("common.retry")}
              </Button>
            </div>
          )}
          {!hasLoaded && loadError ? (
            <div className="grid min-h-64 place-items-center px-4 py-10 text-center" role="alert">
              <div>
                <p className="text-sm text-error-foreground">{loadError}</p>
                <Button
                  className="mt-4"
                  size="sm"
                  variant="outline"
                  onClick={() => setRefreshKey((current) => current + 1)}
                >
                  {t("common.retry")}
                </Button>
              </div>
            </div>
          ) : initialLoading ? (
            <UnlinkedWorksTableSkeleton />
          ) : result.works.length === 0 ? (
            <div className="grid min-h-64 place-items-center px-6 py-10 text-center">
              <div className="max-w-sm">
                <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
                  {query ? <Search className="h-4 w-4" /> : <Inbox className="h-4 w-4" />}
                </div>
                <p className="text-sm font-medium">
                  {query
                    ? t("workMaintenance.noMatching")
                    : reason === "catalog"
                      ? t("workManagement.catalogEmpty")
                      : t("workMaintenance.empty")}
                </p>
                {!query && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {reason === "catalog" ? t("workManagement.catalogDescription") : t("workMaintenance.description")}
                  </p>
                )}
                {query && (
                  <Button className="mt-4" size="sm" variant="outline" onClick={clearSearch}>
                    {t("unlinked.clearSearch")}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <table className="w-full table-fixed text-left text-sm" aria-busy={loading}>
              <UnlinkedWorksTableHead />
              <tbody className="divide-y">
                {result.works.map((work) => {
                  const rowChecking = checkingWorkIds.has(work.id);
                  const rowRetrying = work.metadataIssues.some((issue) => issue.retrying);
                  const selected = selectedWorkIds.has(work.id);
                  const href = `/${encodeURIComponent(work.primaryCode)}`;
                  return (
                    <tr
                      key={work.id}
                      className={`group transition-colors ${selected ? "bg-primary/5" : "hover:bg-muted/30"}`}
                    >
                      <td className="py-2.5 pl-4 align-top max-sm:pl-1.5">
                        <Checkbox
                          className={`sm:mt-3.5 ${touchCheckboxClassName}`}
                          checked={selected}
                          onCheckedChange={(checked) => toggleWork(work.id, checked)}
                          disabled={
                            controlsDisabled ||
                            checking ||
                            deleting ||
                            (!canManageSources && work.metadataIssues.every((issue) => issue.retrying))
                          }
                          aria-label={t("metadataIssues.selectWork", { code: work.primaryCode })}
                        />
                      </td>
                      <td className="min-w-0 py-2.5 pl-2 align-top sm:pl-3">
                        <div className="flex min-w-0 gap-3">
                          <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-md bg-muted ring-1 ring-foreground/5">
                            {work.coverUrl ? (
                              <img
                                src={assetURL(work.coverUrl)}
                                alt=""
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <ImageOff className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <a
                                onClick={navigateWork}
                                href={href}
                                className="font-mono text-xs text-muted-foreground transition-colors hover:text-primary"
                              >
                                {work.primaryCode}
                              </a>
                              {work.noSource && (
                                <Badge variant="outline" className="px-1.5 py-0 text-[11px] text-muted-foreground">
                                  {t("workMaintenance.noSource")}
                                </Badge>
                              )}
                              {work.metadataIssues.length > 0 && (
                                <Badge variant="warning" className="px-1.5 py-0 text-[11px]">
                                  {t("workMaintenance.metadata")}
                                </Badge>
                              )}
                            </div>
                            <a
                              onClick={navigateWork}
                              href={href}
                              className="mt-0.5 block truncate font-medium transition-colors hover:text-primary"
                              title={work.title}
                            >
                              {work.title}
                            </a>
                            <span className="block truncate text-xs text-muted-foreground">
                              {work.circle || "Unknown circle"}
                            </span>
                            {rowRetrying && (
                              <p role="status" className="mt-1.5 flex items-center gap-1.5 text-xs text-primary">
                                <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
                                {t("metadataIssues.retrying")}
                              </p>
                            )}
                            {work.metadataIssues.length > 0 && (
                              <MetadataIssueDetails
                                items={work.metadataIssues}
                                disabled={controlsDisabled || retrying}
                                onRetry={(ids) => void retryMetadata(ids)}
                              />
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 pr-1 align-top sm:pr-3">
                        <div className="flex flex-col items-end gap-0.5 sm:mt-1.5 sm:flex-row sm:justify-end">
                          {canManageSources && work.noSource && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="text-muted-foreground max-sm:h-11 max-sm:w-11"
                              onClick={() => void checkSources([work.id])}
                              disabled={controlsDisabled || checking || deleting}
                              aria-label={`Check sources for ${work.primaryCode}`}
                              title={t("unlinked.checkSources")}
                            >
                              <SearchCheck className={`h-4 w-4 ${rowChecking ? "animate-pulse" : ""}`} />
                            </Button>
                          )}
                          {canManageSources && reason === "no_source" && work.noSource && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="text-muted-foreground hover:bg-error-surface hover:text-error-foreground max-sm:h-11 max-sm:w-11"
                              onClick={() => requestDelete([work])}
                              disabled={controlsDisabled || checking || deleting}
                              aria-label={t("unlinked.deleteFor", { code: work.primaryCode })}
                              title={t("unlinked.deleteInfo")}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            asChild
                            size="icon-sm"
                            variant="ghost"
                            className="text-muted-foreground max-sm:h-11 max-sm:w-11"
                            title={t("unlinked.openDlsite")}
                          >
                            <a
                              href={work.dlsiteUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open DLsite page for ${work.primaryCode}`}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            {t("workMaintenance.rows")}
            <NativeSelect
              fieldSize="sm"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value) as (typeof PAGE_SIZES)[number]);
                setPage(1);
              }}
              className="h-8 px-2 text-xs"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </NativeSelect>
          </label>
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              className="max-sm:h-11 max-sm:w-11"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || loading}
              aria-label={t("collection.previousPage")}
              title={t("collection.previousPage")}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-12 text-center tabular-nums">
              {t("workMaintenance.pageStatus", { page: Math.min(page, totalPages), total: totalPages })}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              className="max-sm:h-11 max-sm:w-11"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages || loading}
              aria-label={t("collection.nextPage")}
              title={t("collection.nextPage")}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {pendingDelete && (
          <UnlinkedWorkDeleteDialog
            pending={pendingDelete}
            deleting={deleting}
            onConfirm={() => void confirmDelete()}
            onClose={() => setPendingDelete(null)}
          />
        )}
      </section>
    </div>
  );
}

/** Phones show only the count next to the icon; the full label stays as the accessible name. */
function BulkLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      <span className="max-sm:sr-only">{label}</span>
      <span className="tabular-nums sm:hidden" aria-hidden="true">
        {count}
      </span>
    </>
  );
}

function UnlinkedWorkDeleteDialog({
  pending,
  deleting,
  onConfirm,
  onClose,
}: {
  pending: PendingDelete;
  deleting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onClose} layer="sheet" size="lg" role="alertdialog" dismissible={!deleting}>
      <DialogHeader title={t("unlinked.confirmTitle")} description={t("unlinked.confirmDescription")} />
      <DialogBody>
        <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/25 px-3 py-2 text-xs">
          {pending.labels.slice(0, 12).map((label) => (
            <div key={label} className="truncate py-1" title={label}>
              {label}
            </div>
          ))}
          {pending.labels.length > 12 && (
            <div className="py-1 text-muted-foreground">+{pending.labels.length - 12} more</div>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={deleting}>
          {t("common.cancel")}
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
          <Trash2 className="h-4 w-4" />
          {deleting ? t("unlinked.deleting") : t("unlinked.deleteCount", { count: pending.workIds.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function UnlinkedWorksTableSkeleton() {
  const { t } = useTranslation();
  return (
    <table
      className="w-full table-fixed text-left text-sm"
      role="status"
      aria-label={t("workMaintenance.loading")}
      aria-busy="true"
    >
      <UnlinkedWorksTableHead />
      <tbody className="divide-y" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <tr key={index}>
            <td className="py-2.5 pl-4 align-top max-sm:pl-1.5">
              <div className="mx-auto h-5 w-5 animate-pulse rounded bg-muted sm:mx-0 sm:mt-3.5" />
            </td>
            <td className="py-2.5 pl-2 sm:pl-3">
              <div className="flex gap-3">
                <div className="h-12 w-12 shrink-0 animate-pulse rounded-md bg-muted" />
                <div className="min-w-0 flex-1 space-y-2 pt-1">
                  <div className="h-2.5 w-20 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
                </div>
              </div>
            </td>
            <td className="py-2.5 pr-3">
              <div className="ml-auto mt-1.5 h-8 w-8 animate-pulse rounded-md bg-muted" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UnlinkedWorksTableHead() {
  const { t } = useTranslation();
  return (
    <>
      <colgroup>
        <col className="w-14 sm:w-11" />
        <col />
        <col className="w-12 sm:w-32" />
      </colgroup>
      <thead className="sr-only">
        <tr>
          <th>{t("unlinked.select")}</th>
          <th>{t("unlinked.titleColumn")}</th>
          <th>{t("unlinked.actions")}</th>
        </tr>
      </thead>
    </>
  );
}

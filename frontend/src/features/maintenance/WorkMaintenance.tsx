import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type MouseEventHandler, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toastFromError, useToast } from "@/components/ui/toast";
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
    window.history.replaceState(window.history.state, "", `/work-management?${params}`);
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

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-3 border-b pb-3">
        <div
          role="tablist"
          aria-label={t("workMaintenance.reason")}
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          {[
            ["catalog", "workManagement.all"],
            ["all", "workMaintenance.all"],
            ...(canSyncMetadata ? [["metadata", "workMaintenance.metadata"]] : []),
            ...(canManageSources ? [["no_source", "workMaintenance.noSource"]] : []),
          ].map(([value, label]) => (
            <Button
              key={value}
              role="tab"
              aria-selected={reason === value}
              aria-controls="metadata-records"
              id={`metadata-tab-${value}`}
              variant={reason === value ? "secondary" : "ghost"}
              className="shrink-0"
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
            </Button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 gap-2">{actions}</div>
      </div>
      <section
        id="metadata-records"
        aria-label={t("workMaintenance.title")}
        className="overflow-hidden rounded-lg border bg-card"
      >
        <div className="flex flex-col gap-3 border-b px-4 py-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">
                {reason === "catalog" ? t("workManagement.allMetadata") : t("workManagement.issues")}
              </h2>
              <Badge variant="outline">{formatNumber(result.total, resolvedLocale)}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {reason === "catalog" ? t("workManagement.catalogDescription") : t("workMaintenance.description")}
            </p>
          </div>
          <form className="flex min-w-0 gap-2 sm:w-[min(100%,28rem)]" onSubmit={submitSearch}>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                maxLength={256}
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
                placeholder={t("unlinked.searchPlaceholder")}
                aria-label={t("workMaintenance.search")}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-9 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              {queryDraft && (
                <button
                  type="button"
                  className="absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={clearSearch}
                  aria-label={t("unlinked.clearSearch")}
                  title={t("unlinked.clearSearch")}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button
              type="submit"
              size="icon"
              variant="outline"
              aria-label={t("unlinked.search")}
              title={t("unlinked.search")}
            >
              <Search className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
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
          <div className="border-b px-4 py-3">
            {runId && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t("metadataIssues.runFilter", { id: runId })}</span>
                <Button variant="ghost" onClick={() => setFilter("all")}>
                  {t("metadataIssues.showAll")}
                </Button>
              </div>
            )}
          </div>
        )}
        <div className="flex min-h-14 flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2">
          <Checkbox
            checked={selection.checked}
            indeterminate={selection.indeterminate}
            onCheckedChange={(checked) =>
              setSelectedWorkIds((current) => setCurrentPageSelected(pageWorkIds, current, checked))
            }
            className="h-11 w-11 sm:h-5 sm:w-5"
            disabled={readOnly || !!loadError || loading || pageWorkIds.length === 0 || checking || deleting}
            aria-label={t("unlinked.selectPage")}
          />
          <span className="mr-auto text-sm text-muted-foreground">
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
              onClick={() => void retryMetadata(retryIds)}
              disabled={readOnly || !!loadError || loading || retrying || retryIds.length === 0}
            >
              <RefreshCw className={`h-4 w-4 ${retrying ? "animate-spin" : ""}`} />
              {t("workMaintenance.retrySelected", { count: retryIds.length })}
            </Button>
          )}
          {canManageSources && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void checkSources(sourceWorks.map((work) => work.id))}
              disabled={sourceWorks.length === 0 || readOnly || !!loadError || loading || checking || deleting}
            >
              <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
              {t("workMaintenance.checkSources", { count: sourceWorks.length })}
            </Button>
          )}
          {canManageSources && reason === "no_source" && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => requestDelete(sourceWorks)}
              disabled={sourceWorks.length === 0 || readOnly || !!loadError || loading || checking || deleting}
            >
              <Trash2 className="h-4 w-4" />
              {t("unlinked.deleteInfo")}
            </Button>
          )}
        </div>

        {notice && (
          <p role="status" className="border-b px-4 py-3 text-sm">
            {notice}
          </p>
        )}
        <div className="min-h-64">
          {loadError && hasLoaded && (
            <div
              className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2"
              role="alert"
            >
              <span className="text-sm text-destructive">
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
                <p className="text-sm text-destructive">{loadError}</p>
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
            <div className="grid min-h-64 place-items-center px-4 py-10 text-center">
              <div>
                <p className="text-sm font-medium">
                  {query
                    ? t("workMaintenance.noMatching")
                    : reason === "catalog"
                      ? t("workManagement.catalogEmpty")
                      : t("workMaintenance.empty")}
                </p>
                {query && (
                  <Button className="mt-4" size="sm" variant="outline" onClick={clearSearch}>
                    {t("unlinked.clearSearch")}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto" aria-busy={loading}>
              <table className="w-full min-w-[680px] table-fixed text-left text-sm">
                <UnlinkedWorksTableHead />
                <tbody className="divide-y">
                  {result.works.map((work) => {
                    const rowChecking = checkingWorkIds.has(work.id);
                    const rowRetrying = work.metadataIssues.some((issue) => issue.retrying);
                    return (
                      <tr key={work.id} className="transition-colors hover:bg-muted/25">
                        <td className="px-4 py-2 align-middle">
                          <Checkbox
                            className="h-11 w-11 sm:h-5 sm:w-5"
                            checked={selectedWorkIds.has(work.id)}
                            onCheckedChange={(checked) => toggleWork(work.id, checked)}
                            disabled={
                              readOnly ||
                              !!loadError ||
                              loading ||
                              checking ||
                              deleting ||
                              (!canManageSources && work.metadataIssues.every((issue) => issue.retrying))
                            }
                            aria-label={t("metadataIssues.selectWork", { code: work.primaryCode })}
                          />
                        </td>
                        <td className="px-2 py-2 align-middle">
                          <div className="grid h-12 w-12 place-items-center overflow-hidden rounded border bg-muted">
                            {work.coverUrl ? (
                              <img
                                src={assetURL(work.coverUrl)}
                                alt=""
                                className="h-full w-full object-contain"
                                loading="lazy"
                              />
                            ) : (
                              <ImageOff className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2 align-middle">
                          <a
                            onClick={navigateWork}
                            href={`/${encodeURIComponent(work.primaryCode)}`}
                            className="font-mono text-xs font-semibold hover:text-primary"
                          >
                            {work.primaryCode}
                          </a>
                        </td>
                        <td className="min-w-0 px-2 py-2 align-middle">
                          <a
                            onClick={navigateWork}
                            href={`/${encodeURIComponent(work.primaryCode)}`}
                            className="block truncate font-medium hover:text-primary"
                            title={work.title}
                          >
                            {work.title}
                          </a>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {work.circle || "Unknown circle"}
                          </span>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {work.noSource && <Badge variant="outline">{t("workMaintenance.noSource")}</Badge>}
                            {work.metadataIssues.length > 0 && (
                              <Badge variant="warning">{t("workMaintenance.metadata")}</Badge>
                            )}
                          </div>
                          {rowRetrying && (
                            <p role="status" className="mt-1 text-xs text-primary">
                              {t("metadataIssues.retrying")}
                            </p>
                          )}
                          {work.metadataIssues.length > 0 && (
                            <MetadataIssueDetails
                              items={work.metadataIssues}
                              disabled={readOnly || !!loadError || loading || retrying}
                              onRetry={(ids) => void retryMetadata(ids)}
                            />
                          )}
                        </td>
                        <td className="px-4 py-2 align-middle">
                          <div className="flex justify-end gap-1">
                            <Button
                              asChild
                              size="icon"
                              variant="ghost"
                              className="h-9 w-9"
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
                            {canManageSources && work.noSource && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-11 w-11 sm:h-9 sm:w-9"
                                onClick={() => void checkSources([work.id])}
                                disabled={readOnly || !!loadError || loading || checking || deleting}
                                aria-label={`Check sources for ${work.primaryCode}`}
                                title={t("unlinked.checkSources")}
                              >
                                <RefreshCw className={`h-4 w-4 ${rowChecking ? "animate-spin" : ""}`} />
                              </Button>
                            )}
                            {canManageSources && reason === "no_source" && work.noSource && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-11 w-11 sm:h-9 sm:w-9 text-destructive hover:text-destructive"
                                onClick={() => requestDelete([work])}
                                disabled={readOnly || !!loadError || loading || checking || deleting}
                                aria-label={t("unlinked.deleteFor", { code: work.primaryCode })}
                                title={t("unlinked.deleteInfo")}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
          <label className="flex items-center gap-2 text-muted-foreground">
            {t("workMaintenance.rows")}
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value) as (typeof PAGE_SIZES)[number]);
                setPage(1);
              }}
              className="h-9 rounded-md border bg-background px-2 text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              Page {Math.min(page, totalPages)} of {totalPages}
            </span>
            <Button
              size="icon"
              variant="outline"
              className="h-9 w-9"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || loading}
              aria-label={t("collection.previousPage")}
              title={t("collection.previousPage")}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-9 w-9"
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
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/45 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !deleting) onClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-lg border bg-card p-5 shadow-xl"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-unlinked-title"
        aria-describedby="delete-unlinked-description"
      >
        <h3 id="delete-unlinked-title" className="text-base font-semibold">
          {t("unlinked.confirmTitle")}
        </h3>
        <p id="delete-unlinked-description" className="mt-2 text-sm text-muted-foreground">
          {t("unlinked.confirmDescription")}
        </p>
        <div className="mt-4 max-h-40 overflow-y-auto rounded-md border bg-muted/25 px-3 py-2 text-xs">
          {pending.labels.slice(0, 12).map((label) => (
            <div key={label} className="truncate py-1" title={label}>
              {label}
            </div>
          ))}
          {pending.labels.length > 12 && (
            <div className="py-1 text-muted-foreground">+{pending.labels.length - 12} more</div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            <Trash2 className="h-4 w-4" />
            {deleting ? t("unlinked.deleting") : t("unlinked.deleteCount", { count: pending.workIds.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function UnlinkedWorksTableSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto" role="status" aria-label={t("workMaintenance.loading")} aria-busy="true">
      <table className="w-full min-w-[680px] table-fixed text-left text-sm">
        <UnlinkedWorksTableHead />
        <tbody className="divide-y" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <tr key={index} className="h-16">
              <td className="px-4 py-2">
                <div className="h-5 w-5 animate-pulse rounded bg-muted" />
              </td>
              <td className="px-2 py-2">
                <div className="h-12 w-12 animate-pulse rounded bg-muted" />
              </td>
              <td className="px-2 py-2">
                <div className="h-3 w-28 animate-pulse rounded bg-muted" />
              </td>
              <td className="px-2 py-2">
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
              </td>
              <td className="px-4 py-2">
                <div className="ml-auto h-8 w-28 animate-pulse rounded bg-muted" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnlinkedWorksTableHead() {
  const { t } = useTranslation();
  return (
    <thead className="border-b bg-muted/35 text-xs text-muted-foreground">
      <tr>
        <th className="w-20 px-4 py-2 font-medium">
          <span className="sr-only">{t("unlinked.select")}</span>
        </th>
        <th className="w-16 px-2 py-2 font-medium">
          <span className="sr-only">{t("unlinked.cover")}</span>
        </th>
        <th className="w-32 px-2 py-2 font-medium">{t("unlinked.code")}</th>
        <th className="px-2 py-2 font-medium">{t("unlinked.titleColumn")}</th>
        <th className="w-40 px-4 py-2 text-right font-medium">{t("unlinked.actions")}</th>
      </tr>
    </thead>
  );
}

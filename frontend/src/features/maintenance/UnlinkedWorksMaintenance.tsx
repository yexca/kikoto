import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toastFromError, useToast } from "@/components/ui/toast";
import { formatNumber } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, assetURL, type Work, type WorksPage } from "@/lib/api";
import { currentPageSelection, pageAfterUnlinkedDelete, setCurrentPageSelected } from "./unlinkedWorksModel";

const PAGE_SIZES = [25, 50] as const;

type PendingDelete = {
  workIds: number[];
  labels: string[];
};

export function UnlinkedWorksMaintenance() {
  const toast = useToast();
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [result, setResult] = useState<WorksPage>({ works: [], page: 1, pageSize: 25, total: 0 });
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedWorkIds, setSelectedWorkIds] = useState<Set<number>>(() => new Set());
  const [checkingWorkIds, setCheckingWorkIds] = useState<Set<number>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    api
      .listWorksPage(page, pageSize, query, "no_source", "all", "recent", "desc", 1, false, controller.signal)
      .then((next) => {
        setResult(next);
        setHasLoaded(true);
        setSelectedWorkIds(new Set());
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadError(t("errors.unavailable"));
        toast.notify(toastFromError(error, t("errors.unavailable")));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, pageSize, query, refreshKey]);

  const pageWorkIds = useMemo(() => result.works.map((work) => work.id), [result.works]);
  const selection = currentPageSelection(pageWorkIds, selectedWorkIds);
  const selectedWorks = useMemo(
    () => result.works.filter((work) => selectedWorkIds.has(work.id)),
    [result.works, selectedWorkIds],
  );
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
    if (workIds.length === 0 || checking || deleting) return;
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
    if (works.length === 0 || checking || deleting) return;
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
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{t("unlinked.title")}</h2>
            <Badge variant="outline">{formatNumber(result.total, resolvedLocale)}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t("unlinked.description")}</p>
        </div>
        <form className="flex min-w-0 gap-2 sm:w-[min(100%,28rem)]" onSubmit={submitSearch}>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder={t("unlinked.searchPlaceholder")}
              aria-label={t("unlinked.searchLabel")}
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

      <div className="flex min-h-14 flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2">
        <Checkbox
          checked={selection.checked}
          indeterminate={selection.indeterminate}
          onCheckedChange={(checked) =>
            setSelectedWorkIds((current) => setCurrentPageSelected(pageWorkIds, current, checked))
          }
          disabled={pageWorkIds.length === 0 || checking || deleting}
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
        <Button
          size="sm"
          variant="outline"
          onClick={() => void checkSources([...selectedWorkIds])}
          disabled={selection.selectedCount === 0 || checking || deleting}
        >
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          {t("unlinked.checkSources")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => requestDelete(selectedWorks)}
          disabled={selection.selectedCount === 0 || checking || deleting}
        >
          <Trash2 className="h-4 w-4" />
          {t("unlinked.deleteInfo")}
        </Button>
      </div>

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
              <p className="text-sm font-medium">{query ? t("unlinked.noMatching") : t("unlinked.noWorks")}</p>
              {query && (
                <Button className="mt-4" size="sm" variant="outline" onClick={clearSearch}>
                  Clear search
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto" aria-busy={loading}>
            <table className="w-full min-w-[760px] table-fixed text-left text-sm">
              <UnlinkedWorksTableHead />
              <tbody className="divide-y">
                {result.works.map((work) => {
                  const rowChecking = checkingWorkIds.has(work.id);
                  return (
                    <tr key={work.id} className="transition-colors hover:bg-muted/25">
                      <td className="px-4 py-2 align-middle">
                        <Checkbox
                          checked={selectedWorkIds.has(work.id)}
                          onCheckedChange={(checked) => toggleWork(work.id, checked)}
                          disabled={checking || deleting}
                          aria-label={`Select ${work.primaryCode}`}
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
                          href={`/${encodeURIComponent(work.primaryCode)}`}
                          className="font-mono text-xs font-semibold hover:text-primary"
                        >
                          {work.primaryCode}
                        </a>
                      </td>
                      <td className="min-w-0 px-2 py-2 align-middle">
                        <a
                          href={`/${encodeURIComponent(work.primaryCode)}`}
                          className="block truncate font-medium hover:text-primary"
                          title={work.title}
                        >
                          {work.title}
                        </a>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {work.circle || "Unknown circle"}
                        </span>
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
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-9 w-9"
                            onClick={() => void checkSources([work.id])}
                            disabled={checking || deleting}
                            aria-label={`Check sources for ${work.primaryCode}`}
                            title={t("unlinked.checkSources")}
                          >
                            <RefreshCw className={`h-4 w-4 ${rowChecking ? "animate-spin" : ""}`} />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-9 w-9 text-destructive hover:text-destructive"
                            onClick={() => requestDelete([work])}
                            disabled={checking || deleting}
                            aria-label={t("unlinked.deleteFor", { code: work.primaryCode })}
                            title={t("unlinked.deleteInfo")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
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
          Rows
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
    <div className="overflow-x-auto" role="status" aria-label={t("unlinked.loading")} aria-busy="true">
      <table className="w-full min-w-[760px] table-fixed text-left text-sm">
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
        <th className="w-12 px-4 py-2 font-medium">
          <span className="sr-only">{t("unlinked.select")}</span>
        </th>
        <th className="w-16 px-2 py-2 font-medium">
          <span className="sr-only">{t("unlinked.cover")}</span>
        </th>
        <th className="w-40 px-2 py-2 font-medium">{t("unlinked.code")}</th>
        <th className="px-2 py-2 font-medium">{t("unlinked.titleColumn")}</th>
        <th className="w-40 px-4 py-2 text-right font-medium">{t("unlinked.actions")}</th>
      </tr>
    </thead>
  );
}

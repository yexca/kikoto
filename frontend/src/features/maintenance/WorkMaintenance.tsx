import { ImageOff, Inbox, Loader2, PanelRightOpen, Pencil, RotateCcw, Search, SearchCheck, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useState, type MouseEvent, type MouseEventHandler } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { WorkSelectionAction, WorkSelectionBar } from "@/components/work-collection/WorkSelectionBar";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { api, assetURL, type MaintenanceWork, type MaintenanceWorkPage, type Work } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { currentPageSelection, pageAfterUnlinkedDelete, setCurrentPageSelected } from "./unlinkedWorksModel";

import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { MaintenanceToolbar, useMaintenanceSearch, type MaintenanceToolbarSlots } from "./MaintenanceControls";
import { MetadataIssueDetails } from "./MetadataIssueDetails";
import { WorkInspector } from "./WorkInspector";
import { MetadataStatus, SourceStatus, canRetryMetadata, metadataRetryWorkId } from "./WorkMaintenanceStatus";

const PAGE_SIZES = [25, 50] as const;

// The inspector sits beside the table only where both keep a readable width.
const INSPECTOR_BESIDE_QUERY = "(min-width: 1280px)";

// Keeps a 44px touch target on phones while drawing the regular 20px box inside it.
const touchCheckboxClassName =
  "max-sm:relative max-sm:h-11 max-sm:w-11 max-sm:border-0 max-sm:bg-transparent max-sm:hover:bg-transparent max-sm:before:absolute max-sm:before:inset-3 max-sm:before:rounded max-sm:before:border max-sm:before:border-input max-sm:before:bg-background max-sm:data-[state=checked]:before:border-primary max-sm:data-[state=checked]:before:bg-primary max-sm:data-[state=indeterminate]:before:border-primary max-sm:data-[state=indeterminate]:before:bg-primary max-sm:[&>svg]:relative";

type PendingDelete = {
  workIds: number[];
  labels: string[];
};

/** A press on the row itself, not on a control or link inside it, opens the inspector. */
function pressedRowItself(event: MouseEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  return !target.closest("a, button, input, label, summary, details, [role='checkbox']");
}

/**
 * Saved work metadata and attention records for one reason, as a management
 * table: the work with its circle, its metadata and source state, then row
 * actions. Pressing a row or its inspect button opens the work inspector,
 * beside the table on wide screens and in a sheet otherwise. The page owns the
 * reason rail and URL state, and composes the metadata editor behind
 * `onEditWork`; this table owns paging, search, selection, the selection bar's
 * recovery actions, and the inspector. Its search and list controls render
 * into the page header through `toolbar`. The list loads on demand rather than
 * polling.
 */
export function WorkMaintenance({
  preferenceRevision = 0,
  listRevision = 0,
  canManageSources,
  canSyncMetadata,
  readOnly = false,
  reason,
  runId,
  toolbar,
  onFilterChange,
  onChanged,
  editingWorkId = null,
  onEditWork,
}: {
  /** Reload presentation after a personal preference changes, keeping list state. */
  preferenceRevision?: number;
  /** Reload the list after its works change elsewhere, keeping list state. */
  listRevision?: number;
  canManageSources: boolean;
  canSyncMetadata: boolean;
  readOnly?: boolean;
  reason: string;
  runId: number | null;
  toolbar: MaintenanceToolbarSlots;
  onFilterChange: (reason: string, runId?: number | null) => void;
  /** Reports that works may have moved between views, such as after a retry, deletion, or refresh. */
  onChanged?: () => void;
  /** The work whose editor is opening, shown as busy on its row. */
  editingWorkId?: number | null;
  /** Opens the metadata editor for a row; `onSaved` reloads the list. */
  onEditWork?: (work: MaintenanceWork, onSaved: () => void) => void;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const wideLayout = !useMobileNavigationLayout();
  const inspectorBeside = useMediaQuery(INSPECTOR_BESIDE_QUERY);
  const inspectorTitleId = useId();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);
  const search = useMaintenanceSearch(() => setPage(1));
  const query = search.query;
  const [result, setResult] = useState<MaintenanceWorkPage>({ works: [], page: 1, pageSize: 25, total: 0 });
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedWorkIds, setSelectedWorkIds] = useState<Set<number>>(() => new Set());
  const [inspectedWorkId, setInspectedWorkId] = useState<number | null>(null);
  const [checkingWorkIds, setCheckingWorkIds] = useState<Set<number>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState("");
  // A custom work has no provider metadata or remote source to retry or check.
  // It never appears in the No available source view, so its own view offers
  // the confirmed deletion when its folder is gone.
  const customView = reason === "custom";
  const deleteView = reason === "no_source" || customView;

  useEffect(() => {
    setPage(1);
    setPendingDelete(null);
    setInspectedWorkId(null);
  }, [reason, runId]);

  useEffect(() => {
    setSelectedWorkIds(new Set());
  }, [page, pageSize, query, reason, runId]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
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
          next.works.filter((work) => canManageSources || canRetryMetadata(work)).map((work) => work.id),
        );
        setSelectedWorkIds((current) => new Set([...current].filter((id) => present.has(id))));
      } catch {
        if (!controller.signal.aborted) setLoadError(t("errors.unavailable"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [page, pageSize, query, reason, runId, refreshKey, preferenceRevision, listRevision, canManageSources, t]);

  const pageWorkIds = useMemo(
    () => result.works.filter((work) => canManageSources || canRetryMetadata(work)).map((work) => work.id),
    [result.works, canManageSources],
  );
  const selection = currentPageSelection(pageWorkIds, selectedWorkIds);
  const selectedWorks = useMemo(
    () => result.works.filter((work) => selectedWorkIds.has(work.id)),
    [result.works, selectedWorkIds],
  );
  // The inspector follows the loaded page, so a work that left the view closes it.
  const inspectedWork = result.works.find((work) => work.id === inspectedWorkId) ?? null;
  // An inspector beside the table repeats the states, so the rows fold them under the title
  // and the titles keep their width.
  const wide = wideLayout && !(inspectorBeside && inspectedWork);
  const columnCount = wide ? 5 : 3;
  const sourceWorks = selectedWorks.filter((work) => work.noSource);
  const retryIds = selectedWorks.flatMap((work) => {
    const id = metadataRetryWorkId(work);
    return id === null ? [] : [id];
  });
  const reload = () => {
    setRefreshKey((current) => current + 1);
    onChanged?.();
  };
  const retryMetadata = async (ids: number[]) => {
    if (!canSyncMetadata || readOnly || retrying || loading || ids.length === 0) return;
    setRetrying(true);
    setNotice("");
    try {
      const response = await api.retryMetadataIssues(ids);
      setNotice(t("metadataIssues.retryResult", response));
      setSelectedWorkIds(new Set());
      reload();
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
  const checking = checkingWorkIds.size > 0;
  const initialLoading = loading && !hasLoaded;
  const clearSearch = search.clear;

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
        reload();
      }
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setCheckingWorkIds(new Set());
    }
  };

  const requestDelete = (works: Work[]) => {
    if (works.length === 0 || !canManageSources || readOnly || loading || !deleteView || checking || deleting) return;
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
      if (nextPage !== page) {
        setPage(nextPage);
        onChanged?.();
      } else reload();
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setDeleting(false);
    }
  };

  const controlsDisabled = readOnly || !!loadError || loading;
  const paginationProps = {
    page,
    pageSize,
    totalItems: result.total,
    totalPages,
    onPageChange: setPage,
  };
  const editWork = (work: MaintenanceWork) => onEditWork?.(work, reload);

  const inspector = inspectedWork && (
    <WorkInspector
      work={inspectedWork}
      titleId={inspectorTitleId}
      canSyncMetadata={canSyncMetadata}
      canManageSources={canManageSources && !readOnly}
      disabled={controlsDisabled}
      retrying={retrying}
      checking={checkingWorkIds.has(inspectedWork.id)}
      editing={editingWorkId === inspectedWork.id}
      onEdit={onEditWork ? () => editWork(inspectedWork) : undefined}
      onRetry={(ids) => void retryMetadata(ids)}
      onCheckSources={!customView && inspectedWork.noSource ? () => void checkSources([inspectedWork.id]) : undefined}
      onOpenWork={navigateWork}
      onClose={() => setInspectedWorkId(null)}
    />
  );

  return (
    <div className="min-w-0 space-y-3">
      <MaintenanceToolbar
        slots={toolbar}
        query={search.draft}
        label={t("workMaintenance.search")}
        placeholder={t("unlinked.searchPlaceholder")}
        loading={loading}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZES}
        onQueryChange={search.setDraft}
        onQueryCommit={search.commit}
        onClear={clearSearch}
        onRefresh={reload}
        onPageSizeChange={(size) => {
          setPageSize(size as (typeof PAGE_SIZES)[number]);
          setPage(1);
        }}
      />
      <div
        className={cn(
          "min-w-0",
          inspectorBeside && inspectedWork && "grid grid-cols-[minmax(0,1fr)_21rem] items-start gap-4",
        )}
      >
        <div className="min-w-0 space-y-3">
          {selection.selectedCount > 0 ? (
            <WorkSelectionBar
              selectedCount={selection.selectedCount}
              scopeSelectableCount={pageWorkIds.length}
              scopeSelectedCount={selection.selectedCount}
              onSelectScope={() => setSelectedWorkIds((current) => setCurrentPageSelected(pageWorkIds, current, true))}
              onClear={() => setSelectedWorkIds(new Set())}
              onExit={() => setSelectedWorkIds(new Set())}
            >
              {canSyncMetadata && !customView && (
                <WorkSelectionAction
                  icon={<RotateCcw className={cn("h-4 w-4", retrying && "animate-spin")} />}
                  label={t("workMaintenance.retry")}
                  count={retryIds.length}
                  disabled={controlsDisabled || retrying}
                  onClick={() => void retryMetadata(retryIds)}
                />
              )}
              {canManageSources && !customView && (
                <WorkSelectionAction
                  icon={<SearchCheck className={cn("h-4 w-4", checking && "animate-pulse")} />}
                  label={t("unlinked.checkSources")}
                  count={sourceWorks.length}
                  disabled={controlsDisabled || checking || deleting}
                  onClick={() => void checkSources(sourceWorks.map((work) => work.id))}
                />
              )}
              {canManageSources && deleteView && (
                <WorkSelectionAction
                  icon={<Trash2 className="h-4 w-4" />}
                  label={t("unlinked.deleteInfo")}
                  count={sourceWorks.length}
                  className="hover:bg-error-surface hover:text-error-foreground"
                  disabled={controlsDisabled || checking || deleting}
                  onClick={() => requestDelete(sourceWorks)}
                />
              )}
            </WorkSelectionBar>
          ) : (
            (hasLoaded || !loadError) && (
              <WorkCollectionPagination {...paginationProps} placement="top" compactMobile compactTop />
            )
          )}
          <section
            id="metadata-records"
            aria-label={t("workMaintenance.title")}
            className="overflow-hidden rounded-lg border bg-card"
          >
            {runId && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-info-border bg-info-surface px-4 py-1.5 text-sm text-info-foreground">
                <span>{t("metadataIssues.runFilter", { id: runId })}</span>
                <Button size="sm" variant="ghost" onClick={() => onFilterChange("all")}>
                  {t("metadataIssues.showAll")}
                </Button>
              </div>
            )}
            {notice && (
              <p role="status" className="border-b px-4 py-2 text-sm text-muted-foreground">
                {notice}
              </p>
            )}
            {loadError && hasLoaded && (
              <div
                className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-error-border bg-error-surface px-4 py-2"
                role="alert"
              >
                <span className="text-sm text-error-foreground">
                  {loadError} {t("unlinked.existingResultsShown")}
                </span>
                <Button size="sm" variant="outline" onClick={reload}>
                  {t("common.retry")}
                </Button>
              </div>
            )}
            <div className="min-h-72">
              <table
                className="w-full table-fixed text-left text-sm"
                aria-busy={loading}
                {...(initialLoading ? { role: "status", "aria-label": t("workMaintenance.loading") } : {})}
              >
                <WorkTableColumns wide={wide} />
                <thead className="border-b bg-muted/30 text-xs font-medium text-muted-foreground">
                  <tr className="h-11">
                    <th scope="col" className="pl-4 align-middle font-medium max-sm:pl-1.5">
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
                    </th>
                    <th scope="col" className="pl-2 align-middle font-medium sm:pl-3">
                      {t("workMaintenance.workColumn")}
                    </th>
                    {wide && (
                      <>
                        <th scope="col" className="px-3 align-middle font-medium">
                          {t("workMaintenance.metadataColumn")}
                        </th>
                        <th scope="col" className="px-3 align-middle font-medium">
                          {t("workMaintenance.sourceColumn")}
                        </th>
                      </>
                    )}
                    <th scope="col" className="pr-1 text-right align-middle font-medium sm:pr-3">
                      <span className="sr-only">{t("unlinked.actions")}</span>
                    </th>
                  </tr>
                </thead>
                {!hasLoaded && loadError ? (
                  <tbody>
                    <tr>
                      <td colSpan={columnCount}>
                        <div className="grid min-h-48 place-items-center px-4 py-10 text-center" role="alert">
                          <div>
                            <p className="text-sm text-error-foreground">{loadError}</p>
                            <Button className="mt-4" size="sm" variant="outline" onClick={reload}>
                              {t("common.retry")}
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                ) : initialLoading ? (
                  <WorkTableSkeletonRows wide={wide} />
                ) : result.works.length === 0 ? (
                  <tbody>
                    <tr>
                      <td colSpan={columnCount}>
                        <div className="grid min-h-48 place-items-center px-6 py-10 text-center">
                          <div className="max-w-sm">
                            <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
                              {query ? <Search className="h-4 w-4" /> : <Inbox className="h-4 w-4" />}
                            </div>
                            <p className="text-sm font-medium">
                              {query
                                ? t("workMaintenance.noMatching")
                                : reason === "catalog"
                                  ? t("workManagement.catalogEmpty")
                                  : customView
                                    ? t("customWorks.worksEmpty")
                                    : t("workMaintenance.empty")}
                            </p>
                            {!query && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {reason === "catalog"
                                  ? t("workManagement.catalogDescription")
                                  : customView
                                    ? t("customWorks.worksDescription")
                                    : t("workMaintenance.description")}
                              </p>
                            )}
                            {query && (
                              <Button className="mt-4" size="sm" variant="outline" onClick={clearSearch}>
                                {t("unlinked.clearSearch")}
                              </Button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                ) : (
                  <tbody className="divide-y">
                    {result.works.map((work) => {
                      const rowChecking = checkingWorkIds.has(work.id);
                      const selected = selectedWorkIds.has(work.id);
                      const inspected = inspectedWorkId === work.id;
                      const href = `/${encodeURIComponent(work.primaryCode)}`;
                      const circle = work.circle || t("workCard.unknownCircle");
                      const rowEditing = editingWorkId === work.id;
                      return (
                        <tr
                          key={work.id}
                          aria-current={inspected || undefined}
                          className={cn(
                            "group cursor-pointer transition-colors",
                            inspected
                              ? "bg-primary/[0.07] shadow-[inset_3px_0_0_hsl(var(--primary))]"
                              : selected
                                ? "bg-primary/5"
                                : "hover:bg-muted/30",
                          )}
                          onClick={(event) => {
                            if (pressedRowItself(event)) setInspectedWorkId(inspected ? null : work.id);
                          }}
                        >
                          <td className="py-2.5 pl-4 align-top max-sm:pl-1.5">
                            <Checkbox
                              className={`sm:mt-3 ${touchCheckboxClassName}`}
                              checked={selected}
                              onCheckedChange={(checked) => toggleWork(work.id, checked)}
                              disabled={
                                controlsDisabled ||
                                checking ||
                                deleting ||
                                (!canManageSources && !canRetryMetadata(work))
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
                                <a
                                  onClick={navigateWork}
                                  href={href}
                                  className="block truncate font-medium leading-snug transition-colors hover:text-primary"
                                  title={work.title}
                                >
                                  {work.title}
                                </a>
                                <p className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                                  <span className="shrink-0 font-mono">{work.primaryCode}</span>
                                  <span aria-hidden="true">·</span>
                                  <span className="truncate" title={circle}>
                                    {circle}
                                  </span>
                                </p>
                                {/* Narrow layouts fold the metadata and source columns under the title. */}
                                {!wide && (
                                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                                    <MetadataStatus work={work} known={canSyncMetadata} />
                                    <SourceStatus tier={work.sourceTier} />
                                  </div>
                                )}
                                {work.metadataIssues.length > 0 && !inspected && (
                                  <MetadataIssueDetails
                                    items={work.metadataIssues}
                                    disabled={controlsDisabled || retrying}
                                    onRetry={(ids) => void retryMetadata(ids)}
                                  />
                                )}
                              </div>
                            </div>
                          </td>
                          {wide && (
                            <>
                              <td className="px-3 py-2.5 align-top">
                                <div className="flex min-h-12 min-w-0 flex-wrap items-center gap-1">
                                  <MetadataStatus work={work} known={canSyncMetadata} />
                                </div>
                              </td>
                              <td className="px-3 py-2.5 align-top">
                                <div className="flex min-h-12 items-center">
                                  <SourceStatus tier={work.sourceTier} />
                                </div>
                              </td>
                            </>
                          )}
                          <td className="py-2.5 pr-1 align-top sm:pr-3">
                            <div className="flex flex-col items-end gap-0.5 sm:mt-1.5 sm:flex-row sm:justify-end">
                              {onEditWork && (
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  className="text-muted-foreground max-sm:h-11 max-sm:w-11"
                                  onClick={() => editWork(work)}
                                  disabled={editingWorkId !== null || deleting}
                                  aria-label={t("workMaintenance.editFor", { code: work.primaryCode })}
                                  title={t("detailActions.editMetadata")}
                                >
                                  {rowEditing ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Pencil className="h-4 w-4" />
                                  )}
                                </Button>
                              )}
                              {canManageSources && !customView && work.noSource && (
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  className="text-muted-foreground max-sm:hidden"
                                  onClick={() => void checkSources([work.id])}
                                  disabled={controlsDisabled || checking || deleting}
                                  aria-label={`Check sources for ${work.primaryCode}`}
                                  title={t("unlinked.checkSources")}
                                >
                                  <SearchCheck className={`h-4 w-4 ${rowChecking ? "animate-pulse" : ""}`} />
                                </Button>
                              )}
                              {canManageSources && deleteView && work.noSource && (
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
                                size="icon-sm"
                                variant="ghost"
                                className={cn(
                                  "max-sm:h-11 max-sm:w-11",
                                  inspected ? "bg-primary/10 text-primary" : "text-muted-foreground",
                                )}
                                aria-label={t("workMaintenance.inspectFor", { code: work.primaryCode })}
                                aria-expanded={inspected}
                                title={t("workMaintenance.inspect")}
                                onClick={() => setInspectedWorkId(inspected ? null : work.id)}
                              >
                                <PanelRightOpen className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                )}
              </table>
            </div>
          </section>
          <WorkCollectionPagination {...paginationProps} placement="bottom" />
        </div>
        {inspector && inspectorBeside && (
          <aside
            aria-labelledby={inspectorTitleId}
            className="theme-card-surface sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-lg border bg-card"
            onKeyDown={(event) => {
              if (event.key === "Escape") setInspectedWorkId(null);
            }}
          >
            {inspector}
          </aside>
        )}
      </div>
      {inspector && !inspectorBeside && (
        <Dialog onClose={() => setInspectedWorkId(null)} layer="sheet" size="md" ariaLabel={inspectedWork.title}>
          {inspector}
        </Dialog>
      )}

      {pendingDelete && (
        <UnlinkedWorkDeleteDialog
          pending={pendingDelete}
          deleting={deleting}
          onConfirm={() => void confirmDelete()}
          onClose={() => setPendingDelete(null)}
        />
      )}
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

function WorkTableSkeletonRows({ wide }: { wide: boolean }) {
  return (
    <tbody className="divide-y" aria-hidden="true">
      {Array.from({ length: 3 }, (_, index) => (
        <tr key={index}>
          <td className="py-2.5 pl-4 align-top max-sm:pl-1.5">
            <div className="mx-auto h-5 w-5 animate-pulse rounded bg-muted sm:mx-0 sm:mt-3" />
          </td>
          <td className="py-2.5 pl-2 sm:pl-3">
            <div className="flex gap-3">
              <div className="h-12 w-12 shrink-0 animate-pulse rounded-md bg-muted" />
              <div className="min-w-0 flex-1 space-y-2 pt-1.5">
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
              </div>
            </div>
          </td>
          {wide && (
            <>
              <td className="px-3 py-2.5">
                <div className="h-4 w-16 animate-pulse rounded bg-muted" />
              </td>
              <td className="px-3 py-2.5">
                <div className="h-4 w-12 animate-pulse rounded bg-muted" />
              </td>
            </>
          )}
          <td className="py-2.5 pr-3">
            <div className="ml-auto mt-1.5 h-8 w-8 animate-pulse rounded-md bg-muted" />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

/** Wide layouts give the metadata and source their own columns; narrow ones fold them under the title. */
function WorkTableColumns({ wide }: { wide: boolean }) {
  return (
    <colgroup>
      <col className="w-14 sm:w-11" />
      <col />
      {wide && (
        <>
          <col className="w-36 xl:w-44" />
          <col className="w-28" />
        </>
      )}
      <col className="w-12 sm:w-32" />
    </colgroup>
  );
}

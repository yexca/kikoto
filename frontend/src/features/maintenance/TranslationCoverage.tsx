import { Check, ImageOff, Inbox, Languages, Loader2, Pencil, Search } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEventHandler, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FloatingSelect } from "@/components/ui/floating-select";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { assetURL } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { interfaceLyricsLanguage } from "@/lib/translationTargets";
import { BatchTranslationDialog } from "./BatchTranslationDialog";
import { MaintenanceToolbar, useMaintenanceSearch, type MaintenanceToolbarSlots } from "./MaintenanceControls";
import {
  translationCoverageApi,
  translationCoverageFilters,
  type TranslationCount,
  type TranslationCoverageFilter,
  type TranslationCoveragePage,
  type TranslationCoverageWork,
  type TranslationSource,
} from "./translationCoverageApi";
import { currentPageSelection, setCurrentPageSelected } from "./unlinkedWorksModel";

const PAGE_SIZES = [25, 50] as const;
const languages: string[] = metadataTagNameLanguages.map(([language]) => language);

// Same 44px phone touch target as the other Metadata work tables.
const touchCheckboxClassName =
  "max-sm:relative max-sm:h-11 max-sm:w-11 max-sm:border-0 max-sm:bg-transparent max-sm:hover:bg-transparent max-sm:before:absolute max-sm:before:inset-3 max-sm:before:rounded max-sm:before:border max-sm:before:border-input max-sm:before:bg-background max-sm:data-[state=checked]:before:border-primary max-sm:data-[state=checked]:before:bg-primary max-sm:data-[state=indeterminate]:before:border-primary max-sm:data-[state=indeterminate]:before:bg-primary max-sm:[&>svg]:relative";

function useWideTable() {
  const query = "(min-width: 1280px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

function stateFromLocation(fallbackLanguage: string) {
  const params = new URLSearchParams(window.location.search);
  const language = params.get("language") ?? "";
  const missing = params.get("missing") ?? "";
  return {
    language: languages.includes(language) ? language : fallbackLanguage,
    missing: (translationCoverageFilters as readonly string[]).includes(missing)
      ? (missing as TranslationCoverageFilter)
      : "any",
  };
}

/**
 * Translation coverage of every work family in one target language: where the
 * title and description come from, and how many shared tags, local file names
 * and local tracks' lyrics the language already has. Selected works can be
 * queued for background LLM translation of their metadata; results wait for
 * review in each work's metadata editor.
 */
export function TranslationCoverage({
  preferenceRevision = 0,
  readOnly = false,
  canTranslate,
  toolbar,
  editingWorkId = null,
  onEditWork,
}: {
  preferenceRevision?: number;
  readOnly?: boolean;
  /** Whether the viewer may queue LLM translations. */
  canTranslate: boolean;
  toolbar: MaintenanceToolbarSlots;
  editingWorkId?: number | null;
  onEditWork?: (work: TranslationCoverageWork, onSaved: () => void) => void;
}) {
  const { t, i18n } = useTranslation();
  const wide = useWideTable();
  const [initial] = useState(() => stateFromLocation(interfaceLyricsLanguage(i18n.resolvedLanguage)));
  const [language, setLanguage] = useState(initial.language);
  const [missing, setMissing] = useState<TranslationCoverageFilter>(initial.missing);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);
  const search = useMaintenanceSearch(() => setPage(1));
  const query = search.query;
  const [result, setResult] = useState<TranslationCoveragePage>({
    language,
    works: [],
    page: 1,
    pageSize: 25,
    total: 0,
  });
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedWorkIds, setSelectedWorkIds] = useState<Set<number>>(() => new Set());
  const [batchOpen, setBatchOpen] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "translation");
    url.searchParams.set("language", language);
    url.searchParams.set("missing", missing);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [language, missing]);

  useEffect(() => {
    setSelectedWorkIds(new Set());
  }, [page, pageSize, query, language, missing]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    translationCoverageApi
      .list({ language, missing, query, page, pageSize }, controller.signal)
      .then((next) => {
        if (next.works.length === 0 && page > 1 && next.total <= (page - 1) * pageSize) {
          setPage(Math.max(1, Math.ceil(next.total / pageSize)));
          return;
        }
        setResult(next);
        setHasLoaded(true);
        setLoadError("");
        const present = new Set(next.works.map((work) => work.id));
        setSelectedWorkIds((current) => new Set([...current].filter((id) => present.has(id))));
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(t("errors.unavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [language, missing, query, page, pageSize, refreshKey, preferenceRevision, t]);

  const reload = () => setRefreshKey((current) => current + 1);
  const pageWorkIds = useMemo(() => result.works.map((work) => work.id), [result.works]);
  const selection = currentPageSelection(pageWorkIds, selectedWorkIds);
  const selectedWorks = result.works.filter((work) => selectedWorkIds.has(work.id));
  const languageLabel = (value: string) =>
    t(metadataTagNameLanguages.find(([candidate]) => candidate === value)?.[1] ?? value);
  const controlsDisabled = readOnly || !!loadError || loading;
  const initialLoading = loading && !hasLoaded;
  const columnCount = wide ? 8 : 3;
  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  const paginationProps = { page, pageSize, totalItems: result.total, totalPages, onPageChange: setPage };
  const navigateWork: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState({}, "", event.currentTarget.getAttribute("href"));
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  const batchLabel = t("translationCoverage.translateSelected", { count: selectedWorks.length });

  return (
    <div className="min-w-0 space-y-3">
      <MaintenanceToolbar
        slots={toolbar}
        query={search.draft}
        label={t("translationCoverage.search")}
        placeholder={t("unlinked.searchPlaceholder")}
        loading={loading}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZES}
        onQueryChange={search.setDraft}
        onQueryCommit={search.commit}
        onClear={search.clear}
        onRefresh={reload}
        onPageSizeChange={(size) => {
          setPageSize(size as (typeof PAGE_SIZES)[number]);
          setPage(1);
        }}
      >
        {canTranslate && (
          <Button
            size="sm"
            variant={selectedWorks.length > 0 ? "default" : "toolbar"}
            title={batchLabel}
            disabled={controlsDisabled || selectedWorks.length === 0}
            onClick={() => setBatchOpen(true)}
          >
            <Languages className="h-4 w-4" />
            <span className="sr-only">{batchLabel}</span>
            <span className="tabular-nums" aria-hidden="true">
              {selectedWorks.length}
            </span>
          </Button>
        )}
      </MaintenanceToolbar>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("translationCoverage.targetLanguage")}</span>
          <FloatingSelect
            value={language}
            ariaLabel={t("translationCoverage.targetLanguage")}
            options={languages.map((value) => ({ value, label: languageLabel(value) }))}
            onValueChange={(value) => {
              setLanguage(value);
              setPage(1);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("translationCoverage.show")}</span>
          <FloatingSelect
            value={missing}
            ariaLabel={t("translationCoverage.show")}
            options={translationCoverageFilters.map((value) => ({
              value,
              label: t(`translationCoverage.filters.${value}`),
            }))}
            onValueChange={(value) => {
              setMissing(value as TranslationCoverageFilter);
              setPage(1);
            }}
          />
        </div>
      </div>
      {(hasLoaded || !loadError) && (
        <WorkCollectionPagination {...paginationProps} placement="top" compactMobile compactTop />
      )}
      <section
        id="metadata-translation"
        aria-label={t("translationCoverage.title")}
        className="overflow-hidden rounded-lg border bg-card"
      >
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
        <div className="min-h-64 overflow-x-auto">
          <table
            className="w-full table-fixed text-left text-sm"
            aria-busy={loading}
            {...(initialLoading ? { role: "status", "aria-label": t("workMaintenance.loading") } : {})}
          >
            <colgroup>
              <col className="w-14 sm:w-11" />
              <col />
              {wide && (
                <>
                  <col className="w-28" />
                  <col className="w-28" />
                  <col className="w-28" />
                  <col className="w-28" />
                  <col className="w-28" />
                </>
              )}
              <col className="w-12 sm:w-16" />
            </colgroup>
            <thead className="border-b bg-muted/30 text-xs font-medium text-muted-foreground">
              <tr className="h-12">
                <th scope="col" className="pl-4 align-middle font-medium max-sm:pl-1.5">
                  <Checkbox
                    checked={selection.checked}
                    indeterminate={selection.indeterminate}
                    onCheckedChange={(checked) =>
                      setSelectedWorkIds((current) => setCurrentPageSelected(pageWorkIds, current, checked))
                    }
                    className={touchCheckboxClassName}
                    disabled={controlsDisabled || pageWorkIds.length === 0}
                    aria-label={t("unlinked.selectPage")}
                  />
                </th>
                <th scope="col" className="pl-2 align-middle font-medium sm:pl-3">
                  {selection.selectedCount > 0 ? (
                    <span className="tabular-nums text-foreground" aria-live="polite">
                      {t("unlinked.selected", { count: selection.selectedCount })}
                    </span>
                  ) : (
                    t("workMaintenance.workColumn")
                  )}
                </th>
                {wide &&
                  (["title", "description", "tags", "files", "lyrics"] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 align-middle font-medium">
                      {t(`translationCoverage.columns.${column}`)}
                    </th>
                  ))}
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
              <tbody aria-hidden="true">
                <tr>
                  <td colSpan={columnCount} className="px-4 py-10 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </td>
                </tr>
              </tbody>
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
                            : t("translationCoverage.empty", { language: languageLabel(language) })}
                        </p>
                        {query && (
                          <Button className="mt-4" size="sm" variant="outline" onClick={search.clear}>
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
                  const selected = selectedWorkIds.has(work.id);
                  const href = `/${encodeURIComponent(work.primaryCode)}`;
                  const coverage = work.translation;
                  const filesOrigin = coverage.originLanguage === language;
                  return (
                    <tr
                      key={work.id}
                      className={`group transition-colors ${selected ? "bg-primary/5" : "hover:bg-muted/30"}`}
                    >
                      <td className="py-2 pl-4 align-top max-sm:pl-1.5">
                        <Checkbox
                          className={`sm:mt-2.5 ${touchCheckboxClassName}`}
                          checked={selected}
                          onCheckedChange={(checked) =>
                            setSelectedWorkIds((current) => {
                              const next = new Set(current);
                              if (checked) next.add(work.id);
                              else next.delete(work.id);
                              return next;
                            })
                          }
                          disabled={controlsDisabled}
                          aria-label={t("metadataIssues.selectWork", { code: work.primaryCode })}
                        />
                      </td>
                      <td className="min-w-0 py-2 pl-2 align-top sm:pl-3">
                        <div className="flex min-w-0 gap-3">
                          <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-muted ring-1 ring-foreground/5">
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
                              className="block font-mono text-xs text-muted-foreground transition-colors hover:text-primary"
                            >
                              {work.primaryCode}
                            </a>
                            <a
                              onClick={navigateWork}
                              href={href}
                              className="block truncate font-medium transition-colors hover:text-primary"
                              title={work.title}
                            >
                              {work.title}
                            </a>
                            <PendingBadges running={coverage.running} review={coverage.review} />
                            {/* Narrow layouts fold the coverage columns under the title. */}
                            {!wide && (
                              <dl className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                                <FoldedCell label={t("translationCoverage.columns.title")}>
                                  <SourceCell source={coverage.title} />
                                </FoldedCell>
                                <FoldedCell label={t("translationCoverage.columns.description")}>
                                  <SourceCell source={coverage.description} />
                                </FoldedCell>
                                <FoldedCell label={t("translationCoverage.columns.tags")}>
                                  <CountCell count={coverage.tags} />
                                </FoldedCell>
                                <FoldedCell label={t("translationCoverage.columns.files")}>
                                  <CountCell count={coverage.files} origin={filesOrigin} />
                                </FoldedCell>
                                <FoldedCell label={t("translationCoverage.columns.lyrics")}>
                                  <CountCell count={coverage.lyrics} />
                                </FoldedCell>
                              </dl>
                            )}
                          </div>
                        </div>
                      </td>
                      {wide && (
                        <>
                          <td className="px-3 py-2 align-top">
                            <div className="pt-2.5">
                              <SourceCell source={coverage.title} />
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="pt-2.5">
                              <SourceCell source={coverage.description} />
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="pt-2.5">
                              <CountCell count={coverage.tags} />
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="pt-2.5">
                              <CountCell count={coverage.files} origin={filesOrigin} />
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="pt-2.5">
                              <CountCell count={coverage.lyrics} />
                            </div>
                          </td>
                        </>
                      )}
                      <td className="py-2 pr-1 align-top sm:pr-3">
                        <div className="flex justify-end sm:mt-1">
                          {onEditWork && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="text-muted-foreground max-sm:h-11 max-sm:w-11"
                              onClick={() => onEditWork(work, reload)}
                              disabled={editingWorkId !== null}
                              aria-label={t("workMaintenance.editFor", { code: work.primaryCode })}
                              title={t("detailActions.editMetadata")}
                            >
                              {editingWorkId === work.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Pencil className="h-4 w-4" />
                              )}
                            </Button>
                          )}
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
      {batchOpen && (
        <BatchTranslationDialog
          works={selectedWorks}
          language={language}
          languageLabel={languageLabel(language)}
          onClose={() => setBatchOpen(false)}
          onQueued={() => {
            setSelectedWorkIds(new Set());
            reload();
          }}
        />
      )}
    </div>
  );
}

function FoldedCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Covered text names its source in neutral type; only missing text takes the attention color. */
function SourceCell({ source }: { source: TranslationSource }) {
  const { t } = useTranslation();
  const label = t(`translationCoverage.sources.${source}`);
  if (source === "missing") return <span className="text-warning-foreground">{label}</span>;
  if (source === "origin") return <span className="text-muted-foreground">{label}</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <Check className="h-3.5 w-3.5 text-success-foreground" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function CountCell({ count, origin = false }: { count: TranslationCount; origin?: boolean }) {
  const { t } = useTranslation();
  if (count.total === 0) {
    return (
      <span className="text-muted-foreground" title={t("translationCoverage.noneToTranslate")}>
        —
      </span>
    );
  }
  if (origin) return <span className="text-muted-foreground">{t("translationCoverage.sources.origin")}</span>;
  const complete = count.done === count.total;
  const label = t("translationCoverage.count", count);
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      {complete ? (
        <Check className="h-3.5 w-3.5 text-success-foreground" aria-hidden="true" />
      ) : (
        <span className="relative h-1.5 w-8 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-success-foreground/70"
            style={{ width: `${(count.done / count.total) * 100}%` }}
          />
        </span>
      )}
      <span className={`tabular-nums ${complete ? "" : "text-warning-foreground"}`}>
        {count.done}/{count.total}
      </span>
    </span>
  );
}

function PendingBadges({ running, review }: { running: number; review: number }) {
  const { t } = useTranslation();
  if (running === 0 && review === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {running > 0 && (
        <Badge variant="info" className="gap-1 px-1.5 py-0 text-[11px]">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t("translationCoverage.running", { count: running })}
        </Badge>
      )}
      {review > 0 && (
        <Badge variant="info" className="px-1.5 py-0 text-[11px]">
          {t("translationCoverage.review", { count: review })}
        </Badge>
      )}
    </div>
  );
}

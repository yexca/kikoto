import { AlertTriangle, Bookmark, Loader2, RefreshCw, Search, Star, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { SortControl } from "@/components/collection/SortControl";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect } from "@/components/ui/floating-select";
import { toastFromError, useToast } from "@/components/ui/toast";
import { WorkCoverThumbnail } from "@/components/work-card/WorkCoverThumbnail";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { dateTimeFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  api,
  type LocalWorkCleanupListening,
  type LocalWorkCleanupPage,
  type LocalWorkCleanupSearch,
  type LocalWorkCleanupSort,
  type LocalWorkCleanupWork,
} from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { startLoad } from "@/lib/effectScope";
import { cn } from "@/lib/tailwindClassNames";
import { openWorkflowRun } from "@/lib/workflowLinks";

import { formatByteSize } from "./cacheCleanupModel";
import {
  availableCleanupPage,
  canForgetWorks,
  defaultLocalWorkCleanupSearch,
  defaultLocalWorkCleanupOptions,
  highRatedWorks,
  localWorkCleanupRequest,
  reconcileSelection,
  retainLocalWorkCleanup,
  retainedLocalWorkCleanup,
  retainedWorkCount,
  sameLocalWorkCleanupSearch,
  selectionSize,
  setLocalWorkCleanupOption,
  unratedWorkCount,
  type LocalWorkCleanupOptions,
} from "./localWorkCleanupModel";

const pageSize = 20;
const ratingChoices = [1, 2, 3, 4, 5] as const;
const defaultDirection: Record<LocalWorkCleanupSort, LocalWorkCleanupSearch["direction"]> = {
  size: "desc",
  rating: "asc",
};
const listeningChoices: readonly LocalWorkCleanupListening[] = ["any", "none", "finished", "settled"];
const sizeChoices = [0, 100 * 1024 ** 2, 500 * 1024 ** 2, 1024 ** 3, 5 * 1024 ** 3] as const;
const sortChoices: readonly LocalWorkCleanupSort[] = ["size", "rating"];
const activeFilterClassName = "border-primary/30 bg-primary/10 text-primary";
const limitChoices = [50, 100, 200, 500] as const;
const anyPool = "\u0000any";

type ConfirmStep = "options" | "highRated";

/**
 * Finds local works to clean up by the administrator's own rating and Quick
 * mark, size, storage pool, and other sources, keeping at most a chosen number
 * of them, and deletes their local files. It can also clear the
 * administrator's rating and Quick mark or forget the works. Nothing is
 * searched until the administrator asks, and the last search stays while they
 * visit other pages.
 */
export function LocalWorkCleanupSection({ readOnly, canForget }: { readOnly: boolean; canForget: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const auth = useAuth();
  const scope = currentClientStorageScope(auth.user?.id ?? null);
  const [restored] = useState(() => retainedLocalWorkCleanup(scope));
  const [draft, setDraft] = useState<LocalWorkCleanupSearch>(restored?.draft ?? defaultLocalWorkCleanupSearch);
  const [searched, setSearched] = useState<LocalWorkCleanupSearch | null>(restored?.searched ?? null);
  const [searchedAt, setSearchedAt] = useState<number | null>(restored?.searchedAt ?? null);
  const [page, setPage] = useState(restored?.page ?? 1);
  const [pages, setPages] = useState<ReadonlyMap<number, LocalWorkCleanupPage>>(restored?.pages ?? new Map());
  const [shown, setShown] = useState<LocalWorkCleanupPage | null>(() => restored?.pages.get(restored.page) ?? null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReadonlyMap<number, LocalWorkCleanupWork>>(restored?.selected ?? new Map());
  const [step, setStep] = useState<ConfirmStep | null>(null);
  const [options, setOptions] = useState<LocalWorkCleanupOptions>(defaultLocalWorkCleanupOptions);
  const [submitting, setSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(restored?.activeRunId ?? null);
  const watchedRun = useWorkflowRunWatcher(activeRunId);

  useEffect(() => {
    retainLocalWorkCleanup({ scope, draft, searched, searchedAt, page, pages, selected, activeRunId });
  }, [activeRunId, draft, page, pages, scope, searched, searchedAt, selected]);

  // A page of the search loads once; going back to it shows it again.
  useEffect(() => {
    if (!searched) return;
    const cached = pages.get(page);
    if (cached) {
      setShown(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    return startLoad((signal) => api.listLocalWorkCleanup(searched, page, pageSize, signal), {
      onSuccess: (next) => {
        // A run that removed every work of the last page moves back to the
        // last page left, which loads in turn.
        const available = availableCleanupPage(page, next.total, pageSize);
        if (available !== page) {
          setPage(available);
          return;
        }
        setPages((current) => new Map(current).set(page, next));
        setShown(next);
        setSelected((current) => reconcileSelection(current, next.works));
        setSearchedAt(Date.now());
        setLoading(false);
      },
      onError: (error) => {
        setLoading(false);
        toast.notify(toastFromError(error, t("cleanup.ratedWorks.loadFailed")));
      },
    });
  }, [page, pages, searched, t, toast]);

  /** Loads the shown page of the same search again, as after a deletion. */
  const refresh = useCallback(() => setPages(new Map()), []);

  const search = () => {
    setSearched(draft);
    setPage(1);
    setPages(new Map());
    setSelected(new Map());
  };

  useEffect(() => {
    const run = watchedRun.run;
    if (!run || run.id !== activeRunId || isActiveWorkflowStatus(run.status)) return;
    setActiveRunId(null);
    if (run.status === "succeeded") toast.success(t("cleanup.ratedWorks.done"));
    else if (run.status === "partial") {
      toast.notify({
        kind: "warning",
        message: t("cleanup.ratedWorks.partial"),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openWorkflowRun(run.id),
      });
    } else {
      toast.notify({
        kind: "error",
        message: t("cleanup.ratedWorks.runFailed"),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openWorkflowRun(run.id),
      });
    }
    refresh();
  }, [activeRunId, refresh, t, toast, watchedRun.run]);

  const changeDraft = (next: Partial<LocalWorkCleanupSearch>) => setDraft((current) => ({ ...current, ...next }));

  const dirty = searched === null || !sameLocalWorkCleanupSearch(draft, searched);
  const pools = shown?.pools ?? [];
  const works = shown?.works ?? [];
  const selectable = works.filter((work) => !work.offline);
  const selectedWorks = useMemo(() => [...selected.values()], [selected]);
  const pageSelected = selectable.filter((work) => selected.has(work.workId)).length;
  const highRated = highRatedWorks(selectedWorks);
  const unrated = unratedWorkCount(selectedWorks);
  const retained = retainedWorkCount(selectedWorks);
  const selectedSize = formatSelectionSize(selectedWorks);
  const busy = submitting || activeRunId !== null;
  const totalPages = Math.max(1, Math.ceil((shown?.total ?? 0) / pageSize));

  const toggleWork = (work: LocalWorkCleanupWork, checked: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(work.workId, work);
      else next.delete(work.workId);
      return next;
    });

  const togglePage = (checked: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      for (const work of selectable) {
        if (checked) next.set(work.workId, work);
        else next.delete(work.workId);
      }
      return next;
    });

  const openConfirm = () => {
    setOptions(defaultLocalWorkCleanupOptions);
    setStep("options");
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const queued = await api.cleanupLocalWorks(localWorkCleanupRequest(selectedWorks, options, highRated.length > 0));
      setStep(null);
      setSelected(new Map());
      setActiveRunId(queued.runId);
      toast.notify({
        kind: "success",
        message: t("cleanup.ratedWorks.queued", { runId: queued.runId }),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openWorkflowRun(queued.runId),
      });
    } catch (error) {
      // A refused request, such as one whose folders changed, is confirmed
      // again from the reloaded list rather than resent as it was.
      setStep(null);
      toast.notify(toastFromError(error, t("cleanup.ratedWorks.failed")));
      refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const navigateWork: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState({}, "", event.currentTarget.getAttribute("href"));
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  return (
    <SettingsSection title={t("cleanup.ratedWorks.title")}>
      <div className="flex flex-wrap items-center gap-2 py-3">
        <FilterSelect
          active={draft.rating !== "any"}
          value={String(draft.rating)}
          ariaLabel={t("cleanup.ratedWorks.ratingLabel")}
          triggerLabel={
            <FilterTrigger icon={<Star className="h-3.5 w-3.5" aria-hidden="true" />}>
              {draft.rating === "unrated"
                ? t("cleanup.ratedWorks.unrated")
                : draft.rating === "any"
                  ? null
                  : t("cleanup.ratedWorks.ratingAtMost", { count: draft.rating })}
            </FilterTrigger>
          }
          options={[
            { value: "any", label: t("cleanup.ratedWorks.anyRating") },
            ...ratingChoices.map((value) => ({
              value: String(value),
              label: t("cleanup.ratedWorks.maxRating", { count: value }),
            })),
            { value: "unrated", label: t("cleanup.ratedWorks.unrated") },
          ]}
          onValueChange={(value) =>
            changeDraft({ rating: value === "any" || value === "unrated" ? value : Number(value) })
          }
        />
        <FilterSelect
          active={draft.listening !== "any"}
          value={draft.listening}
          ariaLabel={t("cleanup.ratedWorks.listeningLabel")}
          triggerLabel={<FilterTrigger icon={<Bookmark className="h-3.5 w-3.5" aria-hidden="true" />} />}
          options={listeningChoices.map((value) => ({ value, label: t(`cleanup.ratedWorks.listening.${value}`) }))}
          onValueChange={(value) => changeDraft({ listening: value as LocalWorkCleanupListening })}
        />
        <FilterSelect
          active={draft.minBytes > 0}
          value={String(draft.minBytes)}
          ariaLabel={t("cleanup.ratedWorks.minSizeLabel")}
          triggerLabel={
            draft.minBytes > 0
              ? t("cleanup.ratedWorks.sizeValue", { size: formatByteSize(draft.minBytes) })
              : t("cleanup.ratedWorks.minSizeLabel")
          }
          options={sizeChoices.map((bytes) => ({
            value: String(bytes),
            label:
              bytes === 0
                ? t("cleanup.ratedWorks.anySize")
                : t("cleanup.ratedWorks.minSize", { size: formatByteSize(bytes) }),
          }))}
          onValueChange={(value) => changeDraft({ minBytes: Number(value) })}
        />
        {pools.length > 0 && (
          <FilterSelect
            active={draft.pool !== null}
            value={draft.pool ?? anyPool}
            ariaLabel={t("cleanup.ratedWorks.poolLabel")}
            triggerLabel={
              draft.pool === null
                ? t("cleanup.ratedWorks.poolLabel")
                : t("cleanup.ratedWorks.poolValue", { pool: draft.pool })
            }
            options={[
              { value: anyPool, label: t("cleanup.ratedWorks.anyPool") },
              ...pools.map((pool) => ({ value: pool.path, label: pool.path })),
            ]}
            onValueChange={(value) => changeDraft({ pool: value === anyPool ? null : value })}
          />
        )}
        <SortControl
          options={sortChoices.map((value) => ({ value, label: t(`cleanup.ratedWorks.sort.${value}`) }))}
          value={draft.sort}
          direction={draft.direction}
          onChange={(sort) => changeDraft({ sort, direction: defaultDirection[sort] })}
          onDirectionChange={(direction) => changeDraft({ direction })}
        />
        <FilterSelect
          active={false}
          value={String(draft.limit)}
          ariaLabel={t("cleanup.ratedWorks.limitLabel")}
          triggerLabel={t("cleanup.ratedWorks.limitValue", { count: draft.limit })}
          options={limitChoices.map((value) => ({
            value: String(value),
            label: t("cleanup.ratedWorks.limit", { count: value }),
          }))}
          onValueChange={(value) => changeDraft({ limit: Number(value) })}
        />
        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          className="ml-auto h-8"
          disabled={loading}
          title={
            searchedAt !== null && !dirty
              ? t("cleanup.ratedWorks.searchedAt", {
                  time: dateTimeFormat(resolvedLocale, { timeStyle: "short" }).format(searchedAt),
                })
              : undefined
          }
          onClick={search}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : dirty ? (
            <Search className="h-4 w-4" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {dirty ? t("cleanup.ratedWorks.search") : t("cleanup.ratedWorks.searchAgain")}
        </Button>
      </div>

      {searched === null || (shown === null && !loading) ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("cleanup.ratedWorks.notSearched")}</p>
      ) : shown === null ? (
        <div className="my-3 h-12 animate-pulse rounded-md bg-muted/60" aria-hidden="true" />
      ) : works.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("cleanup.ratedWorks.empty")}</p>
      ) : (
        <div className={cn("divide-y", loading && "opacity-60")} aria-busy={loading}>
          <label className="flex items-center gap-3 py-2 text-xs font-medium text-muted-foreground">
            <Checkbox
              checked={selectable.length > 0 && pageSelected === selectable.length}
              indeterminate={pageSelected > 0 && pageSelected < selectable.length}
              disabled={readOnly || busy || loading || selectable.length === 0}
              onCheckedChange={togglePage}
            />
            {t("cleanup.ratedWorks.selectPage")}
          </label>
          {works.map((work) => (
            <LocalWorkRow
              key={work.workId}
              work={work}
              checked={selected.has(work.workId)}
              // The rows of the previous search or page stay shown while the
              // next one loads; a work checked then could leave the list yet
              // stay selected for deletion.
              disabled={readOnly || busy || loading || work.offline}
              onCheckedChange={(checked) => toggleWork(work, checked)}
              onNavigate={navigateWork}
            />
          ))}
        </div>
      )}

      {searched !== null && shown && pageSize < shown.total && (
        <WorkCollectionPagination
          page={page}
          pageSize={pageSize}
          totalItems={shown.total}
          totalPages={totalPages}
          onPageChange={setPage}
          placement="bottom"
        />
      )}

      {shown && isLimitedSearch(shown) && (
        <p role="status" className="pt-2 text-xs text-muted-foreground">
          {t("cleanup.ratedWorks.limited", { count: shown.total, matched: shown.matched })}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 py-3">
        <span className="mr-auto text-xs text-muted-foreground">
          {selectedSize === null
            ? t("cleanup.ratedWorks.selectedCount", { count: selectedWorks.length })
            : t("cleanup.ratedWorks.selectedSummary", { count: selectedWorks.length, size: selectedSize })}
        </span>
        <Button
          variant="destructive"
          size="sm"
          disabled={readOnly || busy || selectedWorks.length === 0}
          onClick={openConfirm}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {t("cleanup.ratedWorks.deleteSelected")}
        </Button>
      </div>

      {step === "options" && (
        <Dialog onClose={() => setStep(null)} size="md" role="alertdialog" dismissible={!submitting}>
          <DialogHeader
            title={t("cleanup.ratedWorks.confirmTitle", { count: selectedWorks.length })}
            description={
              selectedSize === null
                ? t("cleanup.ratedWorks.confirmDescriptionUnknownSize")
                : t("cleanup.ratedWorks.confirmDescription", { size: selectedSize })
            }
            icon={<Trash2 className="h-4 w-4" />}
          />
          <DialogBody className="space-y-3">
            {unrated > 0 && (
              <p
                role="status"
                className="flex items-start gap-2 rounded-md bg-warning-surface px-3 py-2.5 text-xs text-warning-foreground"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t("cleanup.ratedWorks.unratedNotice", { count: unrated })}</span>
              </p>
            )}
            <div className="space-y-2">
              <OptionCheckbox
                label={t("cleanup.ratedWorks.clearRating")}
                checked={options.clearRating}
                disabled={submitting}
                onCheckedChange={(checked) =>
                  setOptions((current) => setLocalWorkCleanupOption(current, "clearRating", checked))
                }
              />
              <OptionCheckbox
                label={t("cleanup.ratedWorks.clearMark")}
                checked={options.clearMark}
                disabled={submitting}
                onCheckedChange={(checked) =>
                  setOptions((current) => setLocalWorkCleanupOption(current, "clearMark", checked))
                }
              />
              {canForget && (
                <OptionCheckbox
                  label={t("cleanup.ratedWorks.forget")}
                  description={t("cleanup.ratedWorks.forgetDescription")}
                  checked={options.forget}
                  disabled={submitting || !canForgetWorks(options)}
                  onCheckedChange={(checked) =>
                    setOptions((current) => setLocalWorkCleanupOption(current, "forget", checked))
                  }
                />
              )}
            </div>
            {options.forget && retained > 0 && (
              <p role="status" className="text-xs text-muted-foreground">
                {t("cleanup.ratedWorks.retainedNotice", { count: retained })}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={submitting} onClick={() => setStep(null)}>
              {t("maintenance.cancel")}
            </Button>
            {highRated.length > 0 ? (
              <Button variant="destructive" size="sm" onClick={() => setStep("highRated")}>
                {t("cleanup.ratedWorks.continue")}
              </Button>
            ) : (
              <Button variant="destructive" size="sm" disabled={submitting} onClick={() => void submit()}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {t("cleanup.ratedWorks.confirmDelete")}
              </Button>
            )}
          </DialogFooter>
        </Dialog>
      )}

      {step === "highRated" && (
        <Dialog onClose={() => setStep(null)} size="md" role="alertdialog" dismissible={!submitting}>
          <DialogHeader
            title={t("cleanup.ratedWorks.highRatedTitle")}
            description={t("cleanup.ratedWorks.highRatedDescription", { count: highRated.length })}
            icon={<AlertTriangle className="h-4 w-4" />}
          />
          <DialogBody>
            <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
              {highRated.map((work) => (
                <li key={work.workId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{work.title}</span>
                    <span className="block font-mono text-xs text-muted-foreground">{work.primaryCode}</span>
                  </span>
                  <RatingLabel rating={work.rating} />
                </li>
              ))}
            </ul>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={submitting} onClick={() => setStep("options")}>
              {t("cleanup.ratedWorks.back")}
            </Button>
            <Button variant="destructive" size="sm" disabled={submitting} onClick={() => void submit()}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("cleanup.ratedWorks.deleteAnyway")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </SettingsSection>
  );
}

function LocalWorkRow({
  work,
  checked,
  disabled,
  onCheckedChange,
  onNavigate,
}: {
  work: LocalWorkCleanupWork;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  onNavigate: MouseEventHandler<HTMLAnchorElement>;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex min-w-0 items-center gap-3 py-2.5", work.offline && "opacity-70")}>
      <Checkbox
        checked={checked && !work.offline}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={t("cleanup.ratedWorks.selectWork", { code: work.primaryCode })}
      />
      <WorkCoverThumbnail url={work.coverUrl} />
      <div className="min-w-0 flex-1">
        <a
          href={`/${encodeURIComponent(work.primaryCode)}`}
          onClick={onNavigate}
          className="block truncate text-sm font-medium transition-colors hover:text-primary"
          title={work.title}
        >
          {work.title}
        </a>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{work.primaryCode}</span>
          {work.listeningStatus !== "none" && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t(`workCard.status.${work.listeningStatus}`)}</span>
            </>
          )}
          {work.folders.length > 1 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t("cleanup.ratedWorks.folders", { count: work.folders.length })}</span>
            </>
          )}
        </p>
      </div>
      {work.offline && (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          {t("cleanup.ratedWorks.offline")}
        </Badge>
      )}
      <RatingLabel rating={work.rating} />
      <span className="w-16 shrink-0 text-right text-sm tabular-nums">{formatWorkSize(work)}</span>
    </div>
  );
}

/** A compact filter whose trigger is highlighted while it narrows the search. */
function FilterSelect({
  active,
  ...props
}: Omit<ComponentProps<typeof FloatingSelect>, "className"> & { active: boolean }) {
  return (
    <FloatingSelect
      {...props}
      className={cn("h-8 w-auto gap-1 px-2.5 text-xs font-medium", active && activeFilterClassName)}
    />
  );
}

function FilterTrigger({ icon, children }: { icon: ReactNode; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      {children}
    </span>
  );
}

function RatingLabel({ rating }: { rating: number | null }) {
  const { t } = useTranslation();
  if (rating === null) {
    return (
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{t("cleanup.ratedWorks.unrated")}</span>
    );
  }
  return (
    <span
      className="flex w-14 shrink-0 items-center justify-end gap-1 text-sm tabular-nums"
      aria-label={t("workCard.userRatingValue", { value: rating })}
      title={t("workCard.userRatingValue", { value: rating })}
    >
      <Star className="h-3.5 w-3.5 fill-current text-primary" aria-hidden="true" />
      {rating}
    </span>
  );
}

function OptionCheckbox({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn("flex items-start gap-3", disabled ? "opacity-60" : "cursor-pointer")}>
      <Checkbox className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}

/** A work's size, marked "+" when some of its files have no recorded size. */
function formatWorkSize(work: LocalWorkCleanupWork) {
  const size = selectionSize([work]);
  if (size.bytes === 0 && !size.complete) return "—";
  return size.complete ? formatByteSize(size.bytes) : `${formatByteSize(size.bytes)}+`;
}

/** The selection's size, or null when none of it has a recorded size. */
function formatSelectionSize(works: readonly LocalWorkCleanupWork[]) {
  const size = selectionSize(works);
  if (size.bytes === 0 && !size.complete) return null;
  return size.complete ? formatByteSize(size.bytes) : `${formatByteSize(size.bytes)}+`;
}

/** Whether more works matched than the search keeps. */
function isLimitedSearch(result: LocalWorkCleanupPage) {
  return result.matched > result.total;
}

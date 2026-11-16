import { AlertTriangle, Loader2, RefreshCw, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type MouseEventHandler } from "react";
import { useTranslation } from "react-i18next";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect } from "@/components/ui/floating-select";
import { toastFromError, useToast } from "@/components/ui/toast";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { api, type LocalWorkCleanupPage, type LocalWorkCleanupWork } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { cn } from "@/lib/tailwindClassNames";

import { formatByteSize } from "./cacheCleanupModel";
import {
  canForgetWorks,
  defaultLocalWorkCleanupOptions,
  highRatedWorks,
  localWorkCleanupRequest,
  reconcileSelection,
  retainedWorkCount,
  selectionSize,
  setLocalWorkCleanupOption,
  unratedWorkCount,
  type LocalWorkCleanupOptions,
} from "./localWorkCleanupModel";

const pageSize = 50;
const ratingChoices = [1, 2, 3, 4, 5] as const;

type ConfirmStep = "options" | "highRated";

/**
 * Deletes the local files of the works the administrator rated low, largest
 * first, and can clear their own rating and Quick mark or forget the works.
 */
export function LocalWorkCleanupSection({ readOnly, canForget }: { readOnly: boolean; canForget: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [maxRating, setMaxRating] = useState(2);
  const [includeUnrated, setIncludeUnrated] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<LocalWorkCleanupPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [selected, setSelected] = useState<ReadonlyMap<number, LocalWorkCleanupWork>>(new Map());
  const [step, setStep] = useState<ConfirmStep | null>(null);
  const [options, setOptions] = useState<LocalWorkCleanupOptions>(defaultLocalWorkCleanupOptions);
  const [submitting, setSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const watchedRun = useWorkflowRunWatcher(activeRunId);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api
      .listLocalWorkCleanup({ maxRating, includeUnrated, page, pageSize }, controller.signal)
      .then((next) => {
        setResult(next);
        setSelected((current) => reconcileSelection(current, next.works));
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        toast.notify(toastFromError(error, t("cleanup.ratedWorks.loadFailed")));
      });
    return () => controller.abort();
  }, [includeUnrated, maxRating, page, reloadToken, t, toast]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

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
        onAction: () => openActivityRun(run.id),
      });
    } else {
      toast.notify({
        kind: "error",
        message: t("cleanup.ratedWorks.runFailed"),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openActivityRun(run.id),
      });
    }
    reload();
  }, [activeRunId, reload, t, toast, watchedRun.run]);

  const changeFilter = (next: { maxRating?: number; includeUnrated?: boolean }) => {
    if (next.maxRating !== undefined) setMaxRating(next.maxRating);
    if (next.includeUnrated !== undefined) setIncludeUnrated(next.includeUnrated);
    setPage(1);
    setSelected(new Map());
  };

  const works = result?.works ?? [];
  const selectable = works.filter((work) => !work.offline);
  const selectedWorks = useMemo(() => [...selected.values()], [selected]);
  const pageSelected = selectable.filter((work) => selected.has(work.workId)).length;
  const highRated = highRatedWorks(selectedWorks);
  const unrated = unratedWorkCount(selectedWorks);
  const retained = retainedWorkCount(selectedWorks);
  const selectedSize = formatSelectionSize(selectedWorks);
  const busy = submitting || activeRunId !== null;
  const totalPages = Math.max(1, Math.ceil((result?.total ?? 0) / pageSize));

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
        onAction: () => openActivityRun(queued.runId),
      });
    } catch (error) {
      // A refused request, such as one whose folders changed, is confirmed
      // again from the reloaded list rather than resent as it was.
      setStep(null);
      toast.notify(toastFromError(error, t("cleanup.ratedWorks.failed")));
      reload();
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
    <SettingsSection
      title={t("cleanup.ratedWorks.title")}
      action={
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={reload}
          disabled={loading}
          aria-label={t("cleanup.ratedWorks.refresh")}
          title={t("cleanup.ratedWorks.refresh")}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
        <FloatingSelect
          value={String(maxRating)}
          ariaLabel={t("cleanup.ratedWorks.maxRatingLabel")}
          options={ratingChoices.map((value) => ({
            value: String(value),
            label: t("cleanup.ratedWorks.maxRating", { count: value }),
          }))}
          onValueChange={(value) => changeFilter({ maxRating: Number(value) })}
          className="w-auto"
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox checked={includeUnrated} onCheckedChange={(checked) => changeFilter({ includeUnrated: checked })} />
          {t("cleanup.ratedWorks.includeUnrated")}
        </label>
      </div>

      {result === null ? (
        <div className="my-3 h-12 animate-pulse rounded-md bg-muted/60" aria-hidden="true" />
      ) : works.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("cleanup.ratedWorks.empty")}</p>
      ) : (
        <div className="divide-y">
          <label className="flex items-center gap-3 py-2 text-xs font-medium text-muted-foreground">
            <Checkbox
              checked={selectable.length > 0 && pageSelected === selectable.length}
              indeterminate={pageSelected > 0 && pageSelected < selectable.length}
              disabled={readOnly || busy || selectable.length === 0}
              onCheckedChange={togglePage}
            />
            {t("cleanup.ratedWorks.selectPage")}
          </label>
          {works.map((work) => (
            <LocalWorkRow
              key={work.workId}
              work={work}
              checked={selected.has(work.workId)}
              disabled={readOnly || busy || work.offline}
              onCheckedChange={(checked) => toggleWork(work, checked)}
              onNavigate={navigateWork}
            />
          ))}
        </div>
      )}

      {result && pageSize < result.total && (
        <WorkCollectionPagination
          page={page}
          pageSize={pageSize}
          totalItems={result.total}
          totalPages={totalPages}
          onPageChange={setPage}
          placement="bottom"
        />
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

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/workflows?run=${runId}`);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

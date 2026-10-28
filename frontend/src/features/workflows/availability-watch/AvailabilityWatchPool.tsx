import { ListX, Loader2, Plus } from "lucide-react";
import { forwardRef, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import {
  workCollectionClassName,
  workCollectionStyle,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkSectionHeading } from "@/components/work-collection/WorkSectionHeading";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatRelativeTime, parseWorkflowTimestamp } from "@/features/workflows/runPresentation";
import { useNow } from "@/features/workflows/useRunClock";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { api, type AvailabilityWatchTarget } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { AvailabilityWatchFamilyDialog } from "./AvailabilityWatchFamilyDialog";
import { AvailabilityWatchLoadState } from "./AvailabilityWatchPanel";
import { AvailabilityWatchTargetCard } from "./AvailabilityWatchTargetCard";
import {
  availabilityWatchActionAllowed,
  completedAvailabilityWatchTargets,
  foldedTargetSlots,
  latestAvailabilityCheck,
  parseQuickAddCodes,
  partitionAvailabilityWatchTargets,
} from "./availabilityWatchModel";
import { useArmedConfirm } from "./useArmedConfirm";
import type { AvailabilityWatchState } from "./useAvailabilityWatch";

/**
 * The shared watch pool as a page view: a summary with quick entry, then the
 * available works in full and the works still waiting for a source, folded
 * to whole rows of the page's card grid.
 */
export function AvailabilityWatchPool({
  state,
  readOnly,
  canSyncMetadata,
  canTrackRemote,
  canFetchRemote,
  cardLayout,
  mobileColumns,
  desktopColumns,
  selectedTargetId,
  onSelectTarget,
  revealAvailable,
}: {
  state: AvailabilityWatchState;
  readOnly: boolean;
  canSyncMetadata: boolean;
  canTrackRemote: boolean;
  canFetchRemote: boolean;
  /** The reduced card layout, or null for the regular card. */
  cardLayout: CompactWorkCardLayout | null;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  /** The target whose family dialog is open. */
  selectedTargetId: number | null;
  onSelectTarget: (targetId: number | null) => void;
  /** Changes when a link asks to show the available works, such as a notification. */
  revealAvailable: number;
}) {
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const now = useNow(true, 30_000);
  const confirm = useArmedConfirm<number>();
  const clearConfirm = useArmedConfirm<"completed">();
  const availableRef = useRef<HTMLElement | null>(null);
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [columns, gridRef] = useGridColumnCount();
  const { watch, setWatch, refresh, sourceName } = state;
  const loaded = watch !== null;

  const revealed = useRef(0);
  useEffect(() => {
    if (!loaded || revealAvailable === revealed.current) return;
    revealed.current = revealAvailable;
    window.requestAnimationFrame(() => availableRef.current?.scrollIntoView({ block: "start" }));
  }, [loaded, revealAvailable]);

  if (!watch) return <AvailabilityWatchLoadState state={state} />;

  // The targets decide what the configured action tracks or fetches, so
  // editing them needs the same permissions as that action.
  const manageReadOnly =
    readOnly || !availabilityWatchActionAllowed(watch.action, canSyncMetadata, canTrackRemote, canFetchRemote);
  const { unavailable, available } = partitionAvailabilityWatchTargets(watch.targets);
  const completed = completedAvailabilityWatchTargets(available);
  const failed = unavailable.filter((target) => target.state === "error").length;
  const lastCheck = parseWorkflowTimestamp(latestAvailabilityCheck(watch.targets));
  const selected = watch.targets.find((target) => target.id === selectedTargetId) ?? null;
  const slots = foldedTargetSlots(columns);
  const foldable = unavailable.length > slots;
  const folded = foldable && !expanded;
  const shownUnavailable = folded ? unavailable.slice(0, slots - 1) : unavailable;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseQuickAddCodes(draft, new Set(watch.targets.map((target) => target.workCode)));
    const notes: string[] = [];
    if (parsed.invalid.length > 0) notes.push(workflowCopy("invalidWorkCodes", { codes: parsed.invalid.join(", ") }));
    if (parsed.duplicates > 0) notes.push(workflowCopy("alreadyWatched", { count: parsed.duplicates }));
    setFeedback(notes.join(" "));
    if (parsed.codes.length === 0) {
      if (parsed.invalid.length === 0) setDraft("");
      return;
    }
    setAdding(true);
    try {
      setWatch(await api.addAvailabilityWatchTargets(parsed.codes));
      toast.success(workflowCopy("addedToWatch", { count: parsed.codes.length }));
      setDraft(parsed.invalid.join(" "));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : workflowCopy("monitoringPoolSaveFailed"));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (target: AvailabilityWatchTarget) => {
    if (confirm.armed !== target.id) {
      confirm.arm(target.id);
      return;
    }
    confirm.disarm();
    setRemoving(target.id);
    try {
      await api.removeAvailabilityWatchTarget(target.id);
      setWatch(
        (current) => current && { ...current, targets: current.targets.filter((item) => item.id !== target.id) },
      );
      toast.success(workflowCopy("removedFromWatch", { workCode: target.workCode }));
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("removeTargetFailed", { workCode: target.workCode })));
    } finally {
      setRemoving(null);
    }
  };

  // Clears the completed targets this view shows; one that completes
  // meanwhile waits for the next clear.
  const clearCompleted = async () => {
    if (clearConfirm.armed !== "completed") {
      clearConfirm.arm("completed");
      return;
    }
    clearConfirm.disarm();
    const ids = completed.map((target) => target.id);
    setClearing(true);
    try {
      const next = await api.clearCompletedAvailabilityWatchTargets(ids);
      const remaining = new Set(next.targets.map((target) => target.id));
      setWatch(next);
      toast.success(workflowCopy("clearedCompleted", { count: ids.filter((id) => !remaining.has(id)).length }));
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("clearCompletedFailed")));
    } finally {
      setClearing(false);
    }
  };

  const card = (target: AvailabilityWatchTarget) => (
    <AvailabilityWatchTargetCard
      key={target.id}
      target={target}
      layout={cardLayout}
      sourceName={sourceName(target.availableSourceId)}
      locale={locale}
      now={now}
      readOnly={manageReadOnly}
      armed={confirm.armed === target.id}
      removing={removing === target.id}
      onOpen={() => onSelectTarget(target.id)}
      onRemove={() => void remove(target)}
    />
  );
  const gridProps = {
    className: workCollectionClassName(),
    style: workCollectionStyle(mobileColumns, desktopColumns, cardLayout),
  };

  return (
    <section className="min-w-0 space-y-6" aria-label={workflowCopy("watchPool")}>
      <div className="theme-card-surface rounded-lg border bg-card px-4 py-3.5">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <dl className="flex flex-wrap gap-x-5 gap-y-2 sm:gap-x-6">
            <PoolStat label={workflowCopy("watched")} value={available.length + unavailable.length} />
            <PoolStat label={workflowCopy("availabilityState.available")} value={available.length} tone="success" />
            <PoolStat label={workflowCopy("availabilityState.notAvailable")} value={unavailable.length} />
            {failed > 0 && (
              <PoolStat label={workflowCopy("availabilityState.checkFailed")} value={failed} tone="warning" />
            )}
            <PoolStat
              label={workflowCopy("lastChecked")}
              value={lastCheck ? formatRelativeTime(lastCheck, locale, now) : workflowCopy("never")}
            />
          </dl>
          {!manageReadOnly && (
            <form className="flex w-full min-w-0 gap-2 sm:w-[28rem]" onSubmit={(event) => void add(event)}>
              <Input
                fieldSize="sm"
                className="min-w-0 flex-1 font-mono"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={"RJ00000000, RJ00000001"}
                aria-label={workflowCopy("addWorksToWatch")}
                aria-describedby={feedback ? "availability-watch-add-feedback" : undefined}
                disabled={adding}
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" size="sm" variant="outline" disabled={adding || !draft.trim()}>
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {workflowCopy("add")}
              </Button>
            </form>
          )}
        </div>
        {feedback && (
          <p id="availability-watch-add-feedback" className="mt-2 text-xs text-warning-foreground">
            {feedback}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{workflowCopy("watchPoolDescription")}</p>
      </div>

      <PoolSection
        ref={availableRef}
        id="availability-watch-available"
        label={workflowCopy("availabilityState.available")}
        count={available.length}
        action={
          !manageReadOnly &&
          completed.length > 0 && (
            <div className="flex shrink-0 items-center gap-1">
              {clearConfirm.armed === "completed" && (
                <Button size="sm" variant="ghost" onClick={clearConfirm.disarm}>
                  {workflowCopy("cancel")}
                </Button>
              )}
              <Button
                size="sm"
                variant={clearConfirm.armed === "completed" ? "destructive" : "ghost"}
                title={workflowCopy("clearCompletedHint")}
                disabled={clearing}
                onClick={() => void clearCompleted()}
              >
                {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListX className="h-4 w-4" />}
                {clearConfirm.armed === "completed"
                  ? workflowCopy("confirmClearCompleted", { count: completed.length })
                  : workflowCopy("clearCompleted", { count: completed.length })}
              </Button>
            </div>
          )
        }
      >
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground">{workflowCopy("noAvailableWorks")}</p>
        ) : (
          <ol {...gridProps} aria-label={workflowCopy("availabilityState.available")}>
            {available.map(card)}
          </ol>
        )}
      </PoolSection>

      <PoolSection
        id="availability-watch-unavailable"
        label={workflowCopy("availabilityState.notAvailable")}
        count={unavailable.length}
        action={
          foldable && (
            <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? workflowCopy("showLess") : workflowCopy("showAll", { count: unavailable.length })}
            </Button>
          )
        }
      >
        {unavailable.length === 0 ? (
          <p className="text-sm text-muted-foreground">{workflowCopy("noUnavailableWorks")}</p>
        ) : (
          <ol ref={gridRef} {...gridProps} aria-label={workflowCopy("availabilityState.notAvailable")}>
            {shownUnavailable.map(card)}
            {folded && (
              // Lines up with the cards beside it, below the space of their context line.
              <li className="flex min-h-[9rem] min-w-0 flex-col gap-1.5">
                <span className="h-6 shrink-0" aria-hidden="true" />
                <button
                  type="button"
                  className="w-full flex-1 rounded-lg border border-dashed px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setExpanded(true)}
                >
                  {workflowCopy("moreCount", { count: unavailable.length - shownUnavailable.length })}
                </button>
              </li>
            )}
          </ol>
        )}
      </PoolSection>

      {selected && (
        <AvailabilityWatchFamilyDialog
          target={selected}
          sourceName={sourceName(selected.availableSourceId)}
          readOnly={manageReadOnly}
          onClose={() => onSelectTarget(null)}
          onChanged={() =>
            void refresh().catch((error) => toast.notify(toastFromError(error, workflowCopy("readyPoolRefreshFailed"))))
          }
        />
      )}
    </section>
  );
}

/**
 * The number of tracks a grid lays out at its current width, so a fold can
 * end on a whole row whatever the display options choose.
 */
function useGridColumnCount() {
  const [columns, setColumns] = useState(1);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const measure = () => {
      const tracks = getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length;
      setColumns(Math.max(1, tracks));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
  }, []);
  return [columns, ref] as const;
}

function PoolStat({ label, value, tone }: { label: string; value: ReactNode; tone?: "success" | "warning" }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-base font-semibold tabular-nums leading-tight sm:text-lg",
          tone === "success" && "text-success-foreground",
          tone === "warning" && "text-warning-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

const PoolSection = forwardRef<
  HTMLElement,
  { id: string; label: string; count: number; action?: ReactNode; children: ReactNode }
>(function PoolSection({ id, label, count, action, children }, ref) {
  return (
    <section
      ref={ref}
      className="min-w-0 scroll-mt-[calc(var(--header-height)+var(--safe-area-top)+1rem)]"
      aria-labelledby={`${id}-label`}
    >
      <WorkSectionHeading id={`${id}-label`} title={label} count={count} action={action} />
      {children}
    </section>
  );
});

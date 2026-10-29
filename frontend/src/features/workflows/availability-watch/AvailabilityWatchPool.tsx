import { CheckSquare, GitFork, HardDriveDownload, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Input } from "@/components/ui/input";
import { ActionMenu } from "@/components/ui/action-menu";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import {
  workCollectionClassName,
  workCollectionStyle,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkSelectionAction, WorkSelectionBar } from "@/components/work-collection/WorkSelectionBar";
import { WorkSectionHeading } from "@/components/work-collection/WorkSectionHeading";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatRelativeTime, parseWorkflowTimestamp } from "@/features/workflows/runPresentation";
import { useNow } from "@/features/workflows/useRunClock";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { api, type AvailabilityWatch, type AvailabilityWatchTarget } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { AvailabilityWatchFamilyDialog } from "./AvailabilityWatchFamilyDialog";
import { AvailabilityWatchLoadState } from "./AvailabilityWatchPanel";
import { AvailabilityWatchTargetCard, type WatchCardPermissions } from "./AvailabilityWatchTargetCard";
import {
  cleanableWatchTargets,
  foldedTargetSlots,
  groupWatchTargets,
  latestAvailabilityCheck,
  parseWatchCodes,
  sortWatchTargets,
  WATCH_TARGET_GROUPS,
  watchTargetAllows,
  watchTargetMatches,
  type WatchSort,
  type WatchTargetAction,
  type WatchTargetGroup,
} from "./availabilityWatchModel";
import { useArmedConfirm } from "./useArmedConfirm";
import type { AvailabilityWatchState } from "./useAvailabilityWatch";
import type { WatchTargetActions } from "./useWatchTargetActions";

const SORT_STORE = "kikoto:watch-sort";

function readSort(): WatchSort {
  try {
    return localStorage.getItem(SORT_STORE) === "release" ? "release" : "added";
  } catch {
    return "added";
  }
}

/** Groups that fold to whole rows; the works to act on stay open. */
const FOLDED_GROUPS: ReadonlySet<WatchTargetGroup> = new Set(["waiting", "inLibrary"]);

/** Every code the pool watches, and each family edition, which a new code would duplicate. */
function watchedCodes(watch: AvailabilityWatch) {
  return new Set(watch.targets.flatMap((target) => [target.workCode, ...target.family.map((member) => member.code)]));
}

/**
 * The page's Actions on the watch pool: check it, fetch every available
 * work, and clean up the works the library has or whose Track or Fetch is
 * done. An action the account may not run stays out of the menu.
 */
export function WatchPoolActionMenu({
  watch,
  permissions,
  actions,
}: {
  watch: AvailabilityWatch | null;
  permissions: WatchCardPermissions | null;
  actions: WatchTargetActions;
}) {
  const targets = watch?.targets ?? [];
  const fetchable = targets.filter((target) => watchTargetAllows(target, "fetch"));
  const { inLibrary, done } = cleanableWatchTargets(targets);
  const cleanable = inLibrary.length + done.length;
  const items = permissions
    ? [
        ...(permissions.manage
          ? [
              {
                key: "check",
                label: workflowCopy("watchView.checkPool"),
                hint: workflowCopy("watchView.checkPoolHint"),
                icon: <RefreshCw className="h-4 w-4" />,
                disabled: !watch || targets.length === 0 || actions.busy === "check",
                onSelect: () => actions.check(),
              },
            ]
          : []),
        ...(permissions.fetch
          ? [
              {
                key: "fetch",
                label: workflowCopy("watchView.fetchAll", { count: fetchable.length }),
                hint: workflowCopy("watchView.fetchAllHint"),
                icon: <HardDriveDownload className="h-4 w-4" />,
                disabled: fetchable.length === 0 || actions.busy === "fetch",
                onSelect: () => actions.fetch(fetchable),
              },
            ]
          : []),
        ...(permissions.manage
          ? [
              {
                key: "cleanUp",
                label: workflowCopy("watchView.cleanUp", { count: cleanable }),
                hint: workflowCopy("watchView.cleanUpHint"),
                icon: <Trash2 className="h-4 w-4" />,
                disabled: cleanable === 0 || actions.busy === "cleanUp",
                onSelect: () => actions.cleanUp(inLibrary, done),
              },
            ]
          : []),
      ]
    : [];
  return (
    <ActionMenu
      label={workflowCopy("watchView.actions")}
      buttonLabel={workflowCopy("watchView.actionsButton")}
      keepWhenEmpty
      toolbar
      items={items}
    />
  );
}

/**
 * The shared watch pool as a page view: a summary with Add codes, a search,
 * sort, and Select row, then the works in five groups: available, in
 * progress, waiting, failed checks, and already in the library. Large groups
 * fold to whole rows of the page's card grid; a search opens them.
 */
export function AvailabilityWatchPool({
  state,
  actions,
  permissions,
  cardLayout,
  mobileColumns,
  desktopColumns,
  selectedTargetId,
  onSelectTarget,
  revealAvailable,
  preselect,
  onOpenRun,
}: {
  state: AvailabilityWatchState;
  actions: WatchTargetActions;
  /** The account's permissions on the watch, or null where the view is read-only. */
  permissions: WatchCardPermissions | null;
  /** The reduced card layout, or null for the regular card. */
  cardLayout: CompactWorkCardLayout | null;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  /** The target whose family dialog is open. */
  selectedTargetId: number | null;
  onSelectTarget: (targetId: number | null) => void;
  /** Changes when a link asks to show the available works, such as a notification. */
  revealAvailable: number;
  /** Codes a link asks to select among the available works, such as a run's newly available works. */
  preselect: { key: number; codes: string[] } | null;
  onOpenRun: (runId: number) => void;
}) {
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const now = useNow(true, 30_000);
  const confirm = useArmedConfirm<number>();
  const availableRef = useRef<HTMLElement | null>(null);
  const selectionRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<WatchSort>(readSort);
  const [expanded, setExpanded] = useState<ReadonlySet<WatchTargetGroup>>(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [busyTarget, setBusyTarget] = useState<number | null>(null);
  const [columns, gridRef] = useGridColumnCount();
  const { watch, setWatch, refresh, sourceName } = state;
  const loaded = watch !== null;

  const revealed = useRef(0);
  useEffect(() => {
    if (!loaded || revealAvailable === revealed.current) return;
    revealed.current = revealAvailable;
    window.requestAnimationFrame(() => availableRef.current?.scrollIntoView({ block: "start" }));
  }, [loaded, revealAvailable]);

  // A link's codes become the selection once the pool has loaded.
  const preselected = useRef(0);
  useEffect(() => {
    if (!watch || !preselect || preselect.key === preselected.current) return;
    preselected.current = preselect.key;
    const codes = new Set(preselect.codes);
    const ids = watch.targets
      .filter((target) => codes.has(target.workCode) && watchTargetAllows(target, "fetch"))
      .map((target) => target.id);
    if (ids.length === 0) return;
    setQuery("");
    setSelectionMode(true);
    setSelected(new Set(ids));
    // The selection bar holds the Fetch that acts on them, so it comes into view.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => selectionRef.current?.scrollIntoView({ block: "start" })),
    );
  }, [watch, preselect]);

  const visible = useMemo(
    () =>
      sortWatchTargets(
        (watch?.targets ?? []).filter((target) => watchTargetMatches(target, query)),
        sort,
      ),
    [watch, query, sort],
  );
  const groups = useMemo(() => groupWatchTargets(visible), [visible]);

  // Leaving selection mode clears it, and a removed target leaves it.
  useEffect(() => {
    if (!selectionMode) setSelected(new Set());
  }, [selectionMode]);
  useEffect(() => {
    if (!watch) return;
    const present = new Set(watch.targets.map((target) => target.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => present.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [watch]);

  const parsed = useMemo(
    () => (watch && draft.trim() ? parseWatchCodes(draft, watchedCodes(watch)) : null),
    [watch, draft],
  );

  if (!watch) return <AvailabilityWatchLoadState state={state} />;

  const all = groupWatchTargets(watch.targets);
  const total = WATCH_TARGET_GROUPS.reduce((sum, group) => sum + all[group].length, 0);
  const lastCheck = parseWorkflowTimestamp(latestAvailabilityCheck(watch.targets));
  const familyTarget = watch.targets.find((target) => target.id === selectedTargetId) ?? null;
  const searching = query.trim() !== "";
  const slots = foldedTargetSlots(columns);
  // Every group lays out alike, so the first one shown measures the columns.
  const measuredGroup = WATCH_TARGET_GROUPS.find((group) => groups[group].length > 0);
  const selectedTargets = watch.targets.filter((target) => selected.has(target.id));
  const applicable = (action: WatchTargetAction) =>
    selectedTargets.filter((target) => watchTargetAllows(target, action));

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed || parsed.codes.length === 0) return;
    setAdding(true);
    setAddError("");
    try {
      setWatch(await api.addAvailabilityWatchTargets(parsed.codes));
      toast.success(workflowCopy("addedToWatch", { count: parsed.codes.length }));
      setDraft(parsed.invalid.join(" "));
    } catch (error) {
      setAddError(error instanceof Error ? error.message : workflowCopy("monitoringPoolSaveFailed"));
    } finally {
      setAdding(false);
    }
  };

  const changeSort = (next: string) => {
    const value: WatchSort = next === "release" ? "release" : "added";
    setSort(value);
    try {
      localStorage.setItem(SORT_STORE, value);
    } catch {
      // The order lasts for this visit when local storage is unavailable.
    }
  };

  const withTarget = (target: AvailabilityWatchTarget, run: () => void) => {
    setBusyTarget(target.id);
    run();
    window.setTimeout(() => setBusyTarget((current) => (current === target.id ? null : current)), 600);
  };
  const remove = (target: AvailabilityWatchTarget) => {
    if (confirm.armed !== target.id) {
      confirm.arm(target.id);
      return;
    }
    confirm.disarm();
    withTarget(target, () => actions.removeOne(target));
  };
  const toggle = (id: number, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const card = (target: AvailabilityWatchTarget) => (
    <AvailabilityWatchTargetCard
      key={target.id}
      target={target}
      layout={cardLayout}
      sourceName={sourceName(target.availableSourceId)}
      locale={locale}
      now={now}
      permissions={permissions}
      armed={confirm.armed === target.id}
      busy={busyTarget === target.id}
      selection={
        selectionMode ? { checked: selected.has(target.id), onChange: (checked) => toggle(target.id, checked) } : null
      }
      onOpen={() => (selectionMode ? toggle(target.id, !selected.has(target.id)) : onSelectTarget(target.id))}
      onOpenRun={onOpenRun}
      onTrack={() => withTarget(target, () => actions.track([target]))}
      onFetch={() => actions.fetch([target])}
      onCheck={() => withTarget(target, () => actions.check([target.id]))}
      onRemove={() => remove(target)}
    />
  );
  const gridProps = {
    className: workCollectionClassName(),
    style: workCollectionStyle(mobileColumns, desktopColumns, cardLayout),
  };

  // A mixed selection says how many works each action applies to, beside
  // the buttons and in each button's name.
  const selectionCount = (action: WatchTargetAction) => {
    const count = applicable(action).length;
    const detail =
      count < selectedTargets.length
        ? workflowCopy(`watchView.appliesTo.${action}`, { count, total: selectedTargets.length })
        : undefined;
    return { count, detail };
  };
  const mixedSummary = (["fetch", "track", "check"] as const)
    .map((action) => selectionCount(action))
    .filter((entry) => entry.count > 0 && entry.detail)
    .map((entry) => entry.detail)
    .join(" · ");

  return (
    <section className="min-w-0 space-y-5" aria-label={workflowCopy("watchPool")}>
      <div className="theme-card-surface rounded-lg border bg-card px-4 py-3.5">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <dl className="flex flex-wrap gap-x-5 gap-y-2 sm:gap-x-6">
            <PoolStat label={workflowCopy("watched")} value={total} />
            <PoolStat label={workflowCopy("watchView.groups.available")} value={all.available.length} tone="success" />
            {all.inProgress.length > 0 && (
              <PoolStat label={workflowCopy("watchView.groups.inProgress")} value={all.inProgress.length} />
            )}
            <PoolStat label={workflowCopy("watchView.groups.waiting")} value={all.waiting.length} />
            {all.failed.length > 0 && (
              <PoolStat label={workflowCopy("watchView.groups.failed")} value={all.failed.length} tone="warning" />
            )}
            <PoolStat
              label={workflowCopy("lastChecked")}
              value={lastCheck ? formatRelativeTime(lastCheck, locale, now) : workflowCopy("never")}
            />
          </dl>
          {permissions?.manage && (
            <form className="flex w-full min-w-0 gap-2 sm:w-[28rem]" onSubmit={(event) => void add(event)}>
              <Input
                fieldSize="sm"
                className="min-w-0 flex-1 font-mono"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setAddError("");
                }}
                placeholder={workflowCopy("watchView.addPlaceholder")}
                aria-label={workflowCopy("addWorksToWatch")}
                aria-describedby={parsed ? "availability-watch-add-preview" : undefined}
                disabled={adding}
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={adding || !parsed || parsed.codes.length === 0}
              >
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {parsed && parsed.codes.length > 0
                  ? workflowCopy("watchView.addCount", { count: parsed.codes.length })
                  : workflowCopy("add")}
              </Button>
            </form>
          )}
        </div>
        {parsed && <AddPreview id="availability-watch-add-preview" parsed={parsed} />}
        {addError && <p className="mt-2 text-xs text-error-foreground">{addError}</p>}
        <p className="mt-2 text-xs text-muted-foreground">{workflowCopy("watchPoolDescription")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-56">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            fieldSize="sm"
            type="search"
            className="pl-8"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={workflowCopy("watchView.searchPlaceholder")}
            aria-label={workflowCopy("watchView.search")}
          />
        </div>
        <FloatingSelect
          value={sort}
          onValueChange={changeSort}
          ariaLabel={workflowCopy("watchView.sort")}
          className="w-auto"
          options={[
            { value: "added", label: workflowCopy("watchView.sortAdded") },
            { value: "release", label: workflowCopy("watchView.sortRelease") },
          ]}
        />
        {permissions && (
          <Button
            size="sm"
            variant={selectionMode ? "secondary" : "outline"}
            aria-pressed={selectionMode}
            onClick={() => setSelectionMode(!selectionMode)}
          >
            <CheckSquare className="h-4 w-4" />
            {workflowCopy("watchView.select")}
          </Button>
        )}
      </div>

      {selectionMode && permissions && (
        <div
          ref={selectionRef}
          className="scroll-mt-[calc(var(--header-height)+var(--safe-area-top)+1rem)] space-y-1.5"
        >
          <WorkSelectionBar
            selectedCount={selected.size}
            scopeSelectableCount={visible.length}
            scopeSelectedCount={visible.filter((target) => selected.has(target.id)).length}
            onSelectScope={() => setSelected(new Set([...selected, ...visible.map((target) => target.id)]))}
            onClear={() => setSelected(new Set())}
            onExit={() => setSelectionMode(false)}
          >
            <WorkSelectionAction
              icon={<HardDriveDownload className="h-4 w-4" />}
              label={workflowCopy("fetch")}
              {...selectionCount("fetch")}
              disabled={!permissions.fetch || actions.busy === "fetch"}
              onClick={() => actions.fetch(applicable("fetch"))}
            />
            <WorkSelectionAction
              icon={<GitFork className="h-4 w-4" />}
              label={workflowCopy("track")}
              {...selectionCount("track")}
              disabled={!permissions.track || actions.busy === "track"}
              onClick={() => actions.track(applicable("track"))}
            />
            <WorkSelectionAction
              icon={<RefreshCw className="h-4 w-4" />}
              label={workflowCopy("watchView.checkNow")}
              {...selectionCount("check")}
              disabled={!permissions.manage || actions.busy === "check"}
              onClick={() => actions.check(applicable("check").map((target) => target.id))}
            />
            <WorkSelectionAction
              icon={<Trash2 className="h-4 w-4" />}
              label={workflowCopy("watchView.remove")}
              {...selectionCount("remove")}
              disabled={!permissions.manage || actions.busy === "remove"}
              onClick={() => actions.remove(applicable("remove"))}
            />
          </WorkSelectionBar>
          {mixedSummary && (
            <p className="px-1 text-xs text-muted-foreground" aria-live="polite">
              {mixedSummary}
            </p>
          )}
        </div>
      )}

      {total === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{workflowCopy("watchView.empty")}</p>
      ) : searching && visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{workflowCopy("watchView.noMatches")}</p>
      ) : (
        WATCH_TARGET_GROUPS.map((group) => {
          const items = groups[group];
          if (items.length === 0 && (group !== "available" || searching)) return null;
          const foldable = FOLDED_GROUPS.has(group) && !searching && items.length > slots;
          const folded = foldable && !expanded.has(group);
          const shown = folded ? items.slice(0, slots - 1) : items;
          const setGroupExpanded = (open: boolean) =>
            setExpanded((current) => {
              const next = new Set(current);
              if (open) next.add(group);
              else next.delete(group);
              return next;
            });
          return (
            <PoolSection
              key={group}
              ref={group === "available" ? availableRef : undefined}
              id={`availability-watch-${group}`}
              label={workflowCopy(`watchView.groups.${group}`)}
              count={items.length}
              action={
                foldable && (
                  <Button size="sm" variant="ghost" aria-expanded={!folded} onClick={() => setGroupExpanded(folded)}>
                    {folded ? workflowCopy("showAll", { count: items.length }) : workflowCopy("showLess")}
                  </Button>
                )
              }
            >
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{workflowCopy("noAvailableWorks")}</p>
              ) : (
                <ol
                  ref={group === measuredGroup ? gridRef : undefined}
                  {...gridProps}
                  aria-label={workflowCopy(`watchView.groups.${group}`)}
                >
                  {shown.map(card)}
                  {folded && (
                    // Lines up with the cards beside it, below the space of their context line.
                    <li className="flex min-h-[9rem] min-w-0 flex-col gap-1.5">
                      <span className="h-6 shrink-0" aria-hidden="true" />
                      <button
                        type="button"
                        className="w-full flex-1 rounded-lg border border-dashed px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setGroupExpanded(true)}
                      >
                        {workflowCopy("moreCount", { count: items.length - shown.length })}
                      </button>
                    </li>
                  )}
                </ol>
              )}
            </PoolSection>
          );
        })
      )}

      {familyTarget && (
        <AvailabilityWatchFamilyDialog
          target={familyTarget}
          sourceName={sourceName(familyTarget.availableSourceId)}
          permissions={permissions}
          actions={actions}
          onClose={() => onSelectTarget(null)}
          onChanged={() =>
            void refresh().catch((error) => toast.notify(toastFromError(error, workflowCopy("readyPoolRefreshFailed"))))
          }
        />
      )}
    </section>
  );
}

/** What Add would do with the pasted text, before anything is added. */
function AddPreview({ id, parsed }: { id: string; parsed: ReturnType<typeof parseWatchCodes> }) {
  const parts: { key: string; tone: string; label: string; codes: string[] }[] = [
    {
      key: "new",
      tone: "text-success-foreground",
      label: workflowCopy("watchView.addNew", { count: parsed.codes.length }),
      codes: parsed.codes,
    },
    {
      key: "watched",
      tone: "text-muted-foreground",
      label: workflowCopy("alreadyWatched", { count: parsed.watched.length }),
      codes: parsed.watched,
    },
    {
      key: "invalid",
      tone: "text-warning-foreground",
      label: workflowCopy("watchView.notCodes", { count: parsed.invalid.length }),
      codes: parsed.invalid,
    },
  ].filter((part) => part.codes.length > 0);
  return (
    <ul id={id} className="mt-2 space-y-0.5 text-xs" aria-live="polite">
      {parts.map((part) => (
        <li key={part.key} className="flex min-w-0 gap-1.5">
          <span className={cn("shrink-0 font-medium", part.tone)}>{part.label}</span>
          <span className="min-w-0 truncate font-mono text-muted-foreground" title={part.codes.join(" ")}>
            {part.codes.join(" ")}
          </span>
        </li>
      ))}
    </ul>
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

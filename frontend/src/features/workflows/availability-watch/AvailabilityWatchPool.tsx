import { ImageOff, Languages, Loader2, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastFromError, useToast } from "@/components/ui/toast";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatRelativeTime, parseWorkflowTimestamp } from "@/features/workflows/runPresentation";
import { useNow } from "@/features/workflows/useRunClock";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { api, assetURL, type AvailabilityWatch, type AvailabilityWatchTarget } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { AvailabilityWatchFamilyDialog, availabilityWatchStateLabel } from "./AvailabilityWatchFamilyDialog";
import {
  isAvailableTarget,
  latestAvailabilityCheck,
  parseQuickAddCodes,
  partitionAvailabilityWatchTargets,
  POOL_COLUMN_PREVIEW,
} from "./availabilityWatchModel";
import { useArmedConfirm } from "./useArmedConfirm";

/**
 * The shared watch pool: a summary, quick entry, and the watched work families
 * split by whether a remote source offers any of their editions.
 */
export function AvailabilityWatchPool({
  watch,
  sourceName,
  readOnly,
  onWatchChange,
  onRefresh,
}: {
  watch: AvailabilityWatch;
  sourceName: (sourceId: number | null) => string;
  readOnly: boolean;
  onWatchChange: (watch: AvailabilityWatch) => void;
  onRefresh: () => void;
}) {
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const now = useNow(true, 30_000);
  const confirm = useArmedConfirm<number>();
  const availableRef = useRef<HTMLElement | null>(null);
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expandAvailable, setExpandAvailable] = useState(false);

  // Links open the pool's Available side (`dialog=ready`, from notifications)
  // or one target's family (`target=<id>`, when returning from a work).
  useEffect(() => {
    const sync = () => {
      const search = new URLSearchParams(window.location.search);
      if (search.get("workflow") !== "availability_watch") return;
      const targetId = Number(search.get("target"));
      if (search.get("dialog") === "ready") {
        setExpandAvailable(true);
        window.requestAnimationFrame(() => availableRef.current?.scrollIntoView({ block: "center" }));
      } else if (targetId > 0) {
        setSelectedId(targetId);
      } else {
        return;
      }
      search.delete("dialog");
      search.delete("target");
      search.delete("run");
      window.history.replaceState(window.history.state, "", `/workflows?${search}`);
    };
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("kikoto:navigation", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("kikoto:navigation", sync);
    };
  }, []);

  const { unavailable, available } = partitionAvailabilityWatchTargets(watch.targets);
  const failed = unavailable.filter((target) => target.state === "error").length;
  const lastCheck = parseWorkflowTimestamp(latestAvailabilityCheck(watch.targets));
  const selected = watch.targets.find((target) => target.id === selectedId) ?? null;

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
      onWatchChange(await api.addAvailabilityWatchTargets(parsed.codes));
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
      onWatchChange({ ...watch, targets: watch.targets.filter((item) => item.id !== target.id) });
      toast.success(workflowCopy("removedFromWatch", { workCode: target.workCode }));
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("removeTargetFailed", { workCode: target.workCode })));
    } finally {
      setRemoving(null);
    }
  };

  const chip = (target: AvailabilityWatchTarget) => (
    <PoolCard
      key={target.id}
      target={target}
      readOnly={readOnly}
      armed={confirm.armed === target.id}
      removing={removing === target.id}
      onOpen={() => setSelectedId(target.id)}
      onRemove={() => void remove(target)}
    />
  );

  return (
    <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby="availability-watch-pool">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0">
          <h4 id="availability-watch-pool" className="text-sm font-semibold">
            {workflowCopy("watchPool")}
          </h4>
          <p className="mt-0.5 text-xs text-muted-foreground">{workflowCopy("watchPoolDescription")}</p>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          <PoolStat label={workflowCopy("watched")} value={watch.targets.length} />
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
      </div>

      {!readOnly && (
        <form className="border-t px-4 py-3" onSubmit={(event) => void add(event)}>
          <div className="flex gap-2">
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
          </div>
          {feedback && (
            <p id="availability-watch-add-feedback" className="mt-1.5 text-xs text-warning-foreground">
              {feedback}
            </p>
          )}
        </form>
      )}

      <div className="grid border-t md:grid-cols-2">
        <PoolColumn
          id="availability-watch-unavailable"
          label={workflowCopy("availabilityState.notAvailable")}
          dotClassName="bg-muted-foreground/50"
          empty={workflowCopy("noUnavailableWorks")}
          targets={unavailable}
          render={chip}
        />
        <PoolColumn
          id="availability-watch-available"
          sectionRef={availableRef}
          className="border-t md:border-l md:border-t-0"
          label={workflowCopy("availabilityState.available")}
          dotClassName="bg-success"
          empty={workflowCopy("noAvailableWorks")}
          targets={available}
          expanded={expandAvailable}
          onExpandedChange={setExpandAvailable}
          render={chip}
        />
      </div>

      {selected && (
        <AvailabilityWatchFamilyDialog
          target={selected}
          sourceName={sourceName(selected.availableSourceId)}
          readOnly={readOnly}
          onClose={() => setSelectedId(null)}
          onChanged={onRefresh}
        />
      )}
    </section>
  );
}

function PoolStat({ label, value, tone }: { label: string; value: ReactNode; tone?: "success" | "warning" }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-lg font-semibold tabular-nums leading-tight",
          tone === "success" && "text-success-foreground",
          tone === "warning" && "text-warning-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function PoolColumn({
  id,
  label,
  dotClassName,
  empty,
  targets,
  render,
  className,
  sectionRef,
  expanded: controlledExpanded,
  onExpandedChange,
}: {
  id: string;
  label: string;
  dotClassName: string;
  empty: string;
  targets: AvailabilityWatchTarget[];
  render: (target: AvailabilityWatchTarget) => ReactNode;
  className?: string;
  sectionRef?: Ref<HTMLElement>;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const setExpanded = onExpandedChange ?? setLocalExpanded;
  const folded = targets.length > POOL_COLUMN_PREVIEW && !expanded;
  const shown = folded ? targets.slice(0, POOL_COLUMN_PREVIEW) : targets;
  return (
    <section ref={sectionRef} className={cn("min-w-0 px-4 py-3.5", className)} aria-labelledby={`${id}-label`}>
      <div className="mb-2.5 flex min-h-8 items-center justify-between gap-2">
        <h5 id={`${id}-label`} className="flex items-center gap-2 text-sm font-semibold">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClassName)} aria-hidden />
          {label}
          <span className="font-normal tabular-nums text-muted-foreground">{targets.length}</span>
        </h5>
        {targets.length > POOL_COLUMN_PREVIEW && (
          <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? workflowCopy("showLess") : workflowCopy("showAll", { count: targets.length })}
          </Button>
        )}
      </div>
      {targets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul
          className={cn(
            "grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] sm:gap-2.5",
            expanded && "app-scrollbar max-h-[44rem] overflow-y-auto pr-1",
          )}
          aria-label={label}
        >
          {shown.map(render)}
          {folded && (
            <li className="min-h-[9rem]">
              <button
                type="button"
                className="h-full w-full rounded-lg border border-dashed px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setExpanded(true)}
              >
                {workflowCopy("moreCount", { count: targets.length - POOL_COLUMN_PREVIEW })}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function PoolCard({
  target,
  readOnly,
  armed,
  removing,
  onOpen,
  onRemove,
}: {
  target: AvailabilityWatchTarget;
  readOnly: boolean;
  armed: boolean;
  removing: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [target.coverUrl]);
  const otherEditions = Math.max(0, target.family.length - 1);
  const viaEdition = isAvailableTarget(target) && target.availableCode && target.availableCode !== target.workCode;
  const state = availabilityWatchStateLabel(target);
  return (
    <li
      className={cn(
        "relative min-w-0 overflow-hidden rounded-lg border bg-background transition-colors hover:border-foreground/20",
        armed && "border-error-border hover:border-error-border",
        target.state === "error" && !armed && "border-warning-border",
      )}
    >
      <button
        type="button"
        className="flex w-full min-w-0 flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        title={[target.workCode, target.title, state, target.lastError].filter(Boolean).join("\n")}
        onClick={onOpen}
      >
        <span className="relative block aspect-[4/3] w-full overflow-hidden bg-secondary">
          {target.coverUrl && !imageFailed ? (
            <img
              src={assetURL(target.coverUrl)}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <span className="grid h-full w-full place-items-center text-muted-foreground/60" aria-hidden>
              <ImageOff className="h-5 w-5" />
            </span>
          )}
          {(viaEdition || otherEditions > 0 || target.state === "error") && (
            // The text below repeats these markers for assistive technology.
            <span className="absolute bottom-1 left-1 flex items-center gap-1" aria-hidden>
              {target.state === "error" && (
                <span className="flex h-5 items-center rounded bg-background/90 px-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                </span>
              )}
              {viaEdition && (
                <span className="flex h-5 items-center rounded bg-background/90 px-1 text-success-foreground">
                  <Languages className="h-3 w-3" />
                </span>
              )}
              {otherEditions > 0 && (
                <span className="flex h-5 items-center rounded bg-background/90 px-1 text-[0.6875rem] tabular-nums text-muted-foreground">
                  +{otherEditions}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="block min-w-0 px-2 pb-2 pt-1.5">
          <span className="block font-mono text-[0.6875rem] font-semibold">{target.workCode}</span>
          <span
            className={cn(
              "mt-0.5 line-clamp-2 min-h-[2.75em] text-xs leading-snug",
              !target.title && "text-muted-foreground",
            )}
          >
            {target.title || workflowCopy("editionWithoutMetadata")}
          </span>
          <span className="sr-only">
            {[
              target.state === "error" ? state : "",
              viaEdition ? workflowCopy("availableAsCode", { code: target.availableCode }) : "",
              otherEditions > 0 ? workflowCopy("otherEditions", { count: otherEditions }) : "",
            ]
              .filter(Boolean)
              .join(", ")}
          </span>
        </span>
      </button>
      {!readOnly &&
        (armed || removing ? (
          <button
            type="button"
            className="touch-target absolute right-1 top-1 flex h-6 items-center gap-1 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground shadow-sm transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={workflowCopy("confirmRemoveAria", { workCode: target.workCode })}
            onClick={onRemove}
            disabled={removing}
          >
            {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : workflowCopy("confirmRemove")}
          </button>
        ) : (
          <button
            type="button"
            className="touch-target absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md bg-background/90 text-muted-foreground shadow-sm transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={workflowCopy("removeFromWatchAria", { workCode: target.workCode })}
            title={workflowCopy("removeFromWatch")}
            onClick={onRemove}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ))}
    </li>
  );
}

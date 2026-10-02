import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowDefinition, WorkflowRun, WorkflowTrigger } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { RunStatusDot, useRunLabels } from "./RunOverview";
import {
  formatDuration,
  formatRelativeTime,
  isActiveRunStatus,
  isDemoShowcaseActiveRun,
  parseWorkflowTimestamp,
  runDurationMs,
} from "./runPresentation";
import { useNow } from "./useRunClock";
import { workflowCategory } from "./workflowCategories";
import { localizedWorkflowDefinition, parseNodes, workflowCopy } from "./workflowPageModel";
import { WorkflowRunSlotTarget } from "./WorkflowRunSlot";
import { workflowCategoryIcons, workflowIcon } from "./workflowVisuals";

/** How many recent runs the history strip plots. */
export const workflowHistorySize = 20;

/**
 * The selected workflow's identity and health: what it is, how its recent runs
 * went, and when it runs next. The Run action lands in the header slot.
 */
export function WorkflowDetailFrame({
  definition,
  recentRuns,
  triggers,
  onOpenRun,
  children,
}: {
  definition: WorkflowDefinition;
  recentRuns: WorkflowRun[];
  triggers: WorkflowTrigger[];
  onOpenRun?: (run: WorkflowRun) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const display = localizedWorkflowDefinition(definition);
  const category = workflowCategory(definition.code);
  const Icon = workflowIcon(definition.code);
  const CategoryIcon = workflowCategoryIcons[category];
  const stageCount = parseNodes(definition.definitionJson).length;
  return (
    <div className="workflow-frame min-w-0 space-y-5">
      <header className="flex min-w-0 items-start gap-4">
        <span className="hidden h-12 w-12 shrink-0 place-items-center rounded-lg border bg-card text-primary sm:grid">
          <Icon className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <CategoryIcon className="h-3.5 w-3.5" aria-hidden />
            {t(`workflowPage.categories.${category}`)}
            {stageCount > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="font-medium normal-case tracking-normal">
                  {t("workflowPage.console.steps", { count: stageCount })}
                </span>
              </>
            )}
          </p>
          <h2 className="text-xl font-semibold leading-7 tracking-tight">{display.displayName}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {display.description || workflowCopy("noDescription")}
          </p>
        </div>
        <WorkflowRunSlotTarget />
      </header>
      <WorkflowHealth runs={recentRuns} triggers={triggers} onOpenRun={onOpenRun} />
      {children}
    </div>
  );
}

const finishedStatuses = new Set(["succeeded", "failed", "partial"]);

function WorkflowHealth({
  runs,
  triggers,
  onOpenRun,
}: {
  runs: WorkflowRun[];
  triggers: WorkflowTrigger[];
  onOpenRun?: (run: WorkflowRun) => void;
}) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const latest = runs[0] ?? null;
  const active = runs.some((run) => isActiveRunStatus(run.status) && !isDemoShowcaseActiveRun(run));
  const now = useNow(true, active ? 1000 : 30_000);
  const finished = runs.filter((run) => finishedStatuses.has(run.status));
  const succeeded = finished.filter((run) => run.status === "succeeded").length;
  const durations = finished
    .map((run) => runDurationMs(run, now))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const median = durations.length > 0 ? durations[Math.floor((durations.length - 1) / 2)] : null;
  const latestMoment = latest
    ? parseWorkflowTimestamp(
        isActiveRunStatus(latest.status)
          ? latest.startedAt || latest.createdAt
          : latest.finishedAt || latest.startedAt || latest.createdAt,
      )
    : null;
  const next = nextRun(triggers);
  const nextAt = next?.kind === "schedule" ? parseWorkflowTimestamp(next.trigger.nextRunAt) : null;

  return (
    <section aria-label={t("workflowPage.console.runHistory")} className="overflow-hidden rounded-lg border bg-card">
      <dl className="workflow-health-grid grid gap-px bg-border">
        <HealthStat
          label={t("workflowPage.console.lastRun")}
          value={
            latest ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex w-3.5 shrink-0 justify-center">
                  <RunStatusDot status={latest.status} decorative />
                </span>
                <span className="truncate">{labels.status(latest.status)}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">{t("workflowPage.console.noRunsYet")}</span>
            )
          }
          detail={
            latest ? (
              <>
                <span className="tabular-nums">#{latest.id}</span>
                {latestMoment && !isDemoShowcaseActiveRun(latest) && (
                  <> · {formatRelativeTime(latestMoment, locale, now)}</>
                )}
              </>
            ) : null
          }
          onClick={latest && onOpenRun ? () => onOpenRun(latest) : undefined}
        />
        <HealthStat
          label={t("workflowPage.console.successRate")}
          value={finished.length > 0 ? `${Math.round((succeeded / finished.length) * 100)}%` : "—"}
          detail={
            finished.length > 0 ? t("workflowPage.console.successCount", { succeeded, total: finished.length }) : null
          }
        />
        <HealthStat
          label={t("workflowPage.console.typicalDuration")}
          value={median !== null ? formatDuration(median, locale) : "—"}
          detail={
            durations.length > 0 ? t("workflowPage.console.typicalDurationHint", { count: durations.length }) : null
          }
        />
        <HealthStat
          label={t("workflowPage.console.nextRun")}
          value={
            next?.kind === "schedule" && nextAt ? (
              formatRelativeTime(nextAt, locale, now)
            ) : next?.kind === "startup" ? (
              t("workflowPage.console.onStartup")
            ) : next?.kind === "filesystem_event" ? (
              t("workflowPage.console.onFolderChange")
            ) : (
              <span className="text-muted-foreground">{t("workflowPage.console.manualOnly")}</span>
            )
          }
          detail={next ? next.trigger.displayName : null}
        />
      </dl>
      <RunHistoryStrip runs={runs} now={now} onOpenRun={onOpenRun} />
    </section>
  );
}

function HealthStat({
  label,
  value,
  detail,
  onClick,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <dt className="truncate text-2xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 truncate text-base font-semibold">{value}</dd>
      <dd className="mt-0.5 min-h-4 min-w-0 truncate text-xs text-muted-foreground">{detail}</dd>
    </>
  );
  if (!onClick) return <div className="min-w-0 bg-card px-4 py-3">{body}</div>;
  return (
    <div className="min-w-0 bg-card">
      <button
        type="button"
        className="block h-full w-full min-w-0 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted/70"
        onClick={onClick}
      >
        {body}
      </button>
    </div>
  );
}

const barTone: Record<string, string> = {
  succeeded: "bg-foreground/25 group-hover/bar:bg-foreground/45",
  failed: "bg-error group-hover/bar:bg-error/80",
  partial: "bg-warning group-hover/bar:bg-warning/80",
  running: "bg-info animate-pulse",
  queued: "border border-dashed border-info/70",
};

/**
 * Durations of the latest runs, oldest first. Ordinary successes stay neutral so
 * failures, partial results, and active work are what stand out.
 */
function RunHistoryStrip({
  runs,
  now,
  onOpenRun,
}: {
  runs: WorkflowRun[];
  now: number;
  onOpenRun?: (run: WorkflowRun) => void;
}) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const [hovered, setHovered] = useState<number | null>(null);
  const plotted = runs.slice(0, workflowHistorySize).reverse();
  const durations = plotted.map((run) => runDurationMs(run, now));
  const longest = Math.max(1, ...durations.map((value) => value ?? 0));
  const empty = workflowHistorySize - plotted.length;
  const focus = plotted.find((run) => run.id === hovered) ?? null;
  const focusDuration = focus ? runDurationMs(focus, now) : null;
  const focusMoment = focus ? parseWorkflowTimestamp(focus.finishedAt || focus.startedAt || focus.createdAt) : null;

  return (
    <div className="workflow-history-strip border-t px-4 py-3">
      <div className="workflow-history-label min-w-0">
        <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("workflowPage.console.runHistory")}
        </div>
        <div className="mt-1 min-h-4 truncate text-xs text-muted-foreground">
          {focus ? (
            <>
              <span className="tabular-nums text-foreground">#{focus.id}</span> · {labels.status(focus.status)}
              {focusDuration !== null && <> · {formatDuration(focusDuration, locale)}</>}
              {focusMoment && !isDemoShowcaseActiveRun(focus) && <> · {formatRelativeTime(focusMoment, locale, now)}</>}
            </>
          ) : plotted.length > 0 ? (
            t("workflowPage.console.runHistorySummary", { count: plotted.length })
          ) : (
            t("workflowPage.console.noRunsYet")
          )}
        </div>
      </div>
      {/* A pointer shortcut into the runs that Recent runs below lists for every input. */}
      <div
        aria-hidden
        className="workflow-history-bars flex h-10 w-full min-w-0 items-end gap-[3px]"
        onMouseLeave={() => setHovered(null)}
      >
        {Array.from({ length: empty }, (_, index) => (
          <span key={`empty-${index}`} className="flex h-full max-w-6 flex-1 items-end">
            <span className="h-[3px] w-full rounded-full bg-muted" />
          </span>
        ))}
        {plotted.map((run, index) => {
          const duration = durations[index];
          const height = run.status === "queued" ? 100 : Math.max(14, ((duration ?? 0) / longest) * 100);
          return (
            <span
              key={run.id}
              className={cn("group/bar flex h-full max-w-6 flex-1 items-end", onOpenRun && "cursor-pointer")}
              onMouseEnter={() => setHovered(run.id)}
              onClick={() => onOpenRun?.(run)}
            >
              <span
                className={cn(
                  "w-full rounded-t-[3px] transition-colors",
                  barTone[run.status] ?? "bg-muted-foreground/20",
                  hovered === run.id && "ring-2 ring-ring/40 ring-offset-1 ring-offset-card",
                )}
                style={{ height: `${height}%` }}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

type NextRun =
  | { kind: "schedule"; trigger: WorkflowTrigger }
  | { kind: "startup"; trigger: WorkflowTrigger }
  | { kind: "filesystem_event"; trigger: WorkflowTrigger };

/** The automation that will start this workflow next: the soonest schedule, then startup, then folder changes. */
function nextRun(triggers: WorkflowTrigger[]): NextRun | null {
  const enabled = triggers.filter((trigger) => trigger.enabled);
  const scheduled = enabled
    .filter((trigger) => trigger.triggerType === "schedule" && parseWorkflowTimestamp(trigger.nextRunAt))
    .sort(
      (left, right) =>
        (parseWorkflowTimestamp(left.nextRunAt)?.getTime() ?? 0) -
        (parseWorkflowTimestamp(right.nextRunAt)?.getTime() ?? 0),
    )[0];
  if (scheduled) return { kind: "schedule", trigger: scheduled };
  const startup = enabled.find((trigger) => trigger.triggerType === "startup");
  if (startup) return { kind: "startup", trigger: startup };
  const watch = enabled.find((trigger) => trigger.triggerType === "filesystem_event");
  if (watch) return { kind: "filesystem_event", trigger: watch };
  return null;
}

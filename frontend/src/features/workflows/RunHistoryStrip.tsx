import { useState } from "react";
import { useTranslation } from "react-i18next";

import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowRun } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { useRunLabels } from "./RunOverview";
import {
  formatDuration,
  formatRelativeTime,
  isDemoShowcaseActiveRun,
  parseWorkflowTimestamp,
  runDurationMs,
} from "./runPresentation";

/** How many recent runs the history strip plots. */
export const workflowHistorySize = 20;

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
export function RunHistoryStrip({
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
      {/* A pointer shortcut into the runs that All runs lists in Activity for every input. */}
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

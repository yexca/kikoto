import type { ReactNode } from "react";

import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowRun } from "@/lib/api";

import { RunStatusDot, useRunLabels } from "./RunOverview";
import {
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  isActiveRunStatus,
  parseWorkflowTimestamp,
  runDurationMs,
  runStatusTone,
} from "./runPresentation";
import { useNow } from "./useRunClock";

export function WorkflowHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h3 className="text-lg font-semibold leading-7">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap justify-end gap-2">{actions}</div>}
    </div>
  );
}

export function WorkflowSection({
  title,
  actions,
  children,
  label,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section className="min-w-0 space-y-2" aria-label={label}>
      <div className="flex min-h-9 items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {actions && <div className="-mr-2 flex flex-wrap justify-end gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Relative time with the absolute value available on hover. */
export function RelativeTime({ value, fallback, now }: { value: string | null; fallback: string; now?: number }) {
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const date = parseWorkflowTimestamp(value);
  if (!date) return <>{fallback}</>;
  return (
    <time dateTime={date.toISOString()} title={formatTimestamp(date, locale)}>
      {formatRelativeTime(date, locale, now)}
    </time>
  );
}

const statusText = {
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-error-foreground",
  neutral: "text-muted-foreground",
} as const;

export function RecentRunList({
  runs,
  empty,
  onOpen,
}: {
  runs: WorkflowRun[];
  empty: string;
  onOpen: (run: WorkflowRun) => void;
}) {
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const now = useNow(true, runs.some((run) => isActiveRunStatus(run.status)) ? 1000 : 30_000);
  if (runs.length === 0) return <p className="py-2 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ol className="-mx-2">
      {runs.map((run) => {
        const duration = runDurationMs(run, now);
        const moment = run.finishedAt || run.startedAt || run.createdAt;
        return (
          <li key={run.id}>
            <button
              className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted/70"
              onClick={() => onOpen(run)}
            >
              <span className="flex w-3.5 shrink-0 justify-center">
                <RunStatusDot status={run.status} decorative />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="tabular-nums text-muted-foreground">#{run.id}</span>{" "}
                <span>{labels.trigger(run.triggerType)}</span>
                {run.triggerReason && <span className="text-muted-foreground"> · {run.triggerReason}</span>}
              </span>
              <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
                {duration !== null ? formatDuration(duration, locale) : ""}
              </span>
              <span className={`w-16 shrink-0 text-right text-xs ${statusText[runStatusTone(run.status)]}`}>
                {labels.status(run.status)}
              </span>
              <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                <RelativeTime value={moment} fallback="" now={now} />
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

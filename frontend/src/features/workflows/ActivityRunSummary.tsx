import { useTranslation } from "react-i18next";

import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowRun } from "@/lib/api";

import { RunStatusDot, useRunLabels } from "./RunOverview";
import { RunTransferProgress } from "./RunTransferProgress";
import {
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  hasTransferProgress,
  isActiveRunStatus,
  parseWorkflowTimestamp,
  runDurationMs,
  runStatusTone,
  runTitle,
} from "./runPresentation";
import { useNow } from "./useRunClock";

const statusText = {
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-error-foreground",
  neutral: "text-muted-foreground",
} as const;

/** One Activity list entry: what ran, how it ended, when, and for how long. */
export function ActivityRunSummary({ run }: { run: WorkflowRun }) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const active = isActiveRunStatus(run.status);
  const now = useNow(true, active ? 1000 : 30_000);
  const duration = runDurationMs(run, now);
  const moment =
    parseWorkflowTimestamp(active ? run.startedAt || run.createdAt : run.finishedAt || run.startedAt) ??
    parseWorkflowTimestamp(run.createdAt);
  const jobPercent = run.jobCount > 0 ? Math.min(100, (run.completedJobs / run.jobCount) * 100) : 0;

  return (
    <div className="flex min-w-0 gap-2.5">
      <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
        <RunStatusDot status={run.status} decorative />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium">{runTitle(run, t)}</span>
          {moment && (
            <time
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
              dateTime={moment.toISOString()}
              title={formatTimestamp(moment, locale)}
            >
              {formatRelativeTime(moment, locale, now)}
            </time>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className={statusText[runStatusTone(run.status)]}>{labels.status(run.status)}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">#{run.id}</span>
          <span aria-hidden="true">·</span>
          <span>{labels.trigger(run.triggerType)}</span>
          {duration !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{formatDuration(duration, locale)}</span>
            </>
          )}
        </div>
        {active &&
          (hasTransferProgress(run) ? (
            <div className="pt-1.5">
              <RunTransferProgress run={run} compact />
            </div>
          ) : (
            run.jobCount > 0 && (
              <div className="space-y-1 pt-1.5">
                <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-info transition-[width] duration-700 ease-out"
                    style={{ width: `${jobPercent}%` }}
                  />
                </div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {t("workflowActivity.progress", { current: run.completedJobs, total: run.jobCount })}
                </div>
              </div>
            )
          ))}
      </div>
    </div>
  );
}

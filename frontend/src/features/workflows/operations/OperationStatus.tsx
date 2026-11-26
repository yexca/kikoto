import type { TFunction } from "i18next";
import { ArrowUpRight, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import { RunStatusDot, useRunLabels } from "@/features/workflows/RunOverview";
import {
  formatRelativeTime,
  formatTimestamp,
  isDemoShowcaseActiveRun,
  parseWorkflowTimestamp,
  transferProgress,
  type RunTone,
} from "@/features/workflows/runPresentation";
import { useNow } from "@/features/workflows/useRunClock";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowRun } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { activeRunProgress, type OperationState } from "./operationModel";

const toneText: Record<RunTone, string> = {
  info: "text-info-foreground",
  success: "text-muted-foreground",
  warning: "text-warning-foreground",
  error: "text-error-foreground",
  neutral: "text-muted-foreground",
};

/** A running run's progress as text and, when it can be measured, a fraction. */
function runProgress(run: WorkflowRun, stageCount: number, t: TFunction) {
  if (run.workflowCode === "remote_work_fetch") {
    const transfer = transferProgress(run);
    if (transfer.determinate) return { text: `${Math.round(transfer.percent)}%`, fraction: transfer.percent / 100 };
  }
  const progress = activeRunProgress(run, stageCount);
  if (!progress) return null;
  return {
    text:
      progress.unit === "jobs"
        ? t("workflowActivity.progress", { current: progress.current, total: progress.total })
        : t("workflowPage.console.stepProgress", { current: progress.current, total: progress.total }),
    fraction: progress.current / progress.total,
  };
}

/**
 * An operation's state in one line: idle, starting, queued, running with its
 * progress, or how and when its latest run ended. A state that has a run opens
 * that run, so a failure leads to its details.
 */
export function OperationStatus({
  state,
  moreActive = 0,
  stageCount,
  onOpenRun,
  className,
}: {
  state: OperationState;
  /** The operation's other queued and running runs, besides the one the state follows. */
  moreActive?: number;
  /** The workflow's stages, for a running run's "Step n of m". */
  stageCount: number;
  onOpenRun: (run: WorkflowRun) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const run = "run" in state ? state.run : null;
  const staticExample = run ? isDemoShowcaseActiveRun(run) : false;
  const now = useNow(Boolean(run) && !staticExample, 30_000);

  if (state.phase === "loading") {
    return (
      <div className={className} aria-hidden>
        <Skeleton reveal className="h-4 w-24" />
      </div>
    );
  }
  if (state.phase === "never") {
    return <p className={cn("text-sm text-muted-foreground", className)}>{t("workflowPage.console.neverRun")}</p>;
  }
  if (state.phase === "starting") {
    return (
      <p className={cn("flex items-center gap-2 text-sm text-info-foreground", className)} role="status">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        {t("workflowPage.operations.status.starting")}
      </p>
    );
  }

  const active = state.phase !== "finished";
  const progress = state.phase === "running" ? runProgress(state.run, stageCount, t) : null;
  const statusLabel =
    state.phase === "finished" && state.review
      ? t("workflowPage.operations.status.review")
      : labels.status(state.run.status);
  const moment = active
    ? null
    : parseWorkflowTimestamp(state.run.finishedAt || state.run.startedAt || state.run.createdAt);
  const tone: RunTone = state.phase === "finished" ? (state.review ? "warning" : state.tone) : "info";
  const details: ReactNode[] = [];
  if (active && state.run.subject) details.push(state.run.subject);
  if (progress) details.push(<span className="tabular-nums">{progress.text}</span>);
  if (active && moreActive > 0) details.push(t("workflowPage.operations.status.moreActive", { count: moreActive }));
  if (moment)
    details.push(
      <time dateTime={moment.toISOString()} title={formatTimestamp(moment, locale)}>
        {formatRelativeTime(moment, locale, now)}
      </time>,
    );

  return (
    <button
      type="button"
      className={cn(
        "group/status touch-target block min-w-0 max-w-full rounded-md text-left text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      aria-label={t("workflowPage.operations.openRun", { id: state.run.id, status: statusLabel })}
      onClick={() => onOpenRun(state.run)}
    >
      <span className="flex min-w-0 items-center gap-2">
        {state.phase === "running" ? (
          <Loader2 className={cn("h-3.5 w-3.5 shrink-0 text-info", !staticExample && "animate-spin")} aria-hidden />
        ) : (
          <RunStatusDot status={state.run.status} decorative />
        )}
        <span className={cn("shrink-0 font-medium", toneText[tone])}>{statusLabel}</span>
        {details.map((detail, index) => (
          <span key={index} className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate">{detail}</span>
          </span>
        ))}
        {/* An outcome that asks for a look always shows where it leads; touch has no hover to reveal it. */}
        <ArrowUpRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-opacity",
            tone !== "error" &&
              tone !== "warning" &&
              "opacity-0 group-hover/status:opacity-100 group-focus-visible/status:opacity-100",
          )}
          aria-hidden
        />
      </span>
      {progress && (
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-info/15 w-40 max-w-full" aria-hidden>
          <span
            className="block h-full rounded-full bg-info transition-[width] duration-700 ease-out"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.fraction)) * 100)}%` }}
          />
        </span>
      )}
    </button>
  );
}

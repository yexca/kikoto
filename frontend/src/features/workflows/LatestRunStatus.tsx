import { ArrowUpRight, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { RunStatusDot, useRunLabels } from "@/features/workflows/RunOverview";
import {
  formatRelativeTime,
  formatTimestamp,
  parseWorkflowTimestamp,
  runStatusTone,
} from "@/features/workflows/runPresentation";
import { useNow } from "@/features/workflows/useRunClock";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { cn } from "@/lib/tailwindClassNames";

import type { LatestRun } from "./latestRunModel";

const toneText = {
  info: "text-info-foreground",
  success: "text-muted-foreground",
  warning: "text-warning-foreground",
  error: "text-error-foreground",
  neutral: "text-muted-foreground",
} as const;

/**
 * A workflow's newest run in one line of a settings panel: its name, how the
 * run stands, when, and, for an account that may open Activity, the way to that
 * run. Success stays quiet. A failure is named and always shows where it
 * leads, since touch has no hover to reveal it; its reason is in the run, not
 * repeated here.
 */
export function LatestRunStatus({
  label,
  run,
  onOpen,
  className,
}: {
  /** What the run is of, such as "Latest refresh". */
  label: string;
  /** `undefined` while loading, `null` when the workflow never ran. */
  run: LatestRun | null | undefined;
  /** Opens the run in Activity; absent for an account that cannot open it. */
  onOpen?: (runId: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const moment = run?.at ? parseWorkflowTimestamp(run.at) : null;
  const now = useNow(Boolean(moment), 30_000);

  let status: ReactNode;
  if (run === undefined) {
    status = <span className="text-muted-foreground">…</span>;
  } else if (run === null) {
    status = <span className="text-muted-foreground">{t("workflowPage.console.neverRun")}</span>;
  } else {
    const statusLabel = labels.status(run.status);
    const tone = runStatusTone(run.status);
    const body = (
      <span className="flex min-w-0 items-center gap-2">
        {run.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-info" aria-hidden />
        ) : (
          <RunStatusDot status={run.status} decorative />
        )}
        <span className={cn("shrink-0 font-medium", toneText[tone])}>{statusLabel}</span>
        {moment && (
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span aria-hidden>·</span>
            <time className="min-w-0 truncate" dateTime={moment.toISOString()} title={formatTimestamp(moment, locale)}>
              {formatRelativeTime(moment, locale, now)}
            </time>
          </span>
        )}
        {onOpen && (
          <ArrowUpRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-opacity",
              tone !== "error" &&
                tone !== "warning" &&
                "opacity-0 group-hover/run:opacity-100 group-focus-visible/run:opacity-100",
            )}
            aria-hidden
          />
        )}
      </span>
    );
    status = onOpen ? (
      <button
        type="button"
        className="group/run touch-target block min-w-0 max-w-full rounded-md text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("workflowPage.operations.openRun", { id: run.id, status: statusLabel })}
        onClick={() => onOpen(run.id)}
      >
        {body}
      </button>
    ) : (
      body
    );
  }

  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs", className)}
      role="group"
      aria-label={label}
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {status}
    </div>
  );
}

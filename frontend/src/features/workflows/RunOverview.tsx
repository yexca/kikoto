import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowNodeRun, WorkflowRun } from "@/lib/api";

import {
  formatDuration,
  formatTimestamp,
  isActiveRunStatus,
  parseWorkflowTimestamp,
  runDurationMs,
  runStatusTone,
  type RunTone,
} from "./runPresentation";
import { useNow } from "./useRunClock";

const badgeVariant: Record<RunTone, "info" | "success" | "warning" | "error" | "outline"> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
  neutral: "outline",
};

const dotClass: Record<RunTone, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  neutral: "bg-muted-foreground/45",
};

export function useRunLabels() {
  const { t } = useTranslation();
  return {
    status: (status: string) => t(`workflowActivity.status.${status}`, { defaultValue: status }),
    trigger: (triggerType: string) =>
      t(`workflowActivity.trigger.${triggerType}`, { defaultValue: triggerType.replace(/_/g, " ") }),
  };
}

export function RunStatusBadge({ status }: { status: string }) {
  const labels = useRunLabels();
  return <Badge variant={badgeVariant[runStatusTone(status)]}>{labels.status(status)}</Badge>;
}

/** Status glyph; pass `decorative` when the status is already spelled out next to it. */
export function RunStatusDot({
  status,
  decorative = false,
  className = "",
}: {
  status: string;
  decorative?: boolean;
  className?: string;
}) {
  const labels = useRunLabels();
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": labels.status(status) } as const);
  if (status === "running")
    return <Loader2 className={`h-3.5 w-3.5 shrink-0 animate-spin text-info ${className}`} {...a11y} />;
  const tone =
    status === "queued"
      ? "rounded-full border border-muted-foreground/60"
      : `rounded-full ${dotClass[runStatusTone(status)]}`;
  return <span className={`inline-block h-2 w-2 shrink-0 ${tone} ${className}`} {...a11y} />;
}

function Timestamp({ value, fallback }: { value: string; fallback: string }) {
  const { resolvedLocale } = useLocale();
  const date = parseWorkflowTimestamp(value);
  if (!date) return <span className="text-muted-foreground">{fallback}</span>;
  return (
    <time dateTime={date.toISOString()} title={value}>
      {formatTimestamp(date, intlLocaleFor(resolvedLocale))}
    </time>
  );
}

/** Start, finish, duration and trigger facts for a single run. */
export function RunFacts({ run }: { run: WorkflowRun }) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  const active = isActiveRunStatus(run.status);
  const now = useNow(active);
  const duration = runDurationMs(run, now);
  const facts: Array<{ key: string; label: string; value: ReactNode }> = [
    {
      key: "started",
      label: t("workflowActivity.facts.started"),
      value: (
        <Timestamp
          value={run.startedAt}
          fallback={run.status === "queued" ? t("workflowActivity.status.queued") : t("workflowActivity.facts.none")}
        />
      ),
    },
    {
      key: "finished",
      label: t("workflowActivity.facts.finished"),
      value: active ? (
        <span className="text-info-foreground">{t("workflowActivity.facts.inProgress")}</span>
      ) : (
        <Timestamp value={run.finishedAt} fallback={t("workflowActivity.facts.none")} />
      ),
    },
    {
      key: "duration",
      label: t("workflowActivity.facts.duration"),
      value:
        duration === null ? (
          <span className="text-muted-foreground">{t("workflowActivity.facts.none")}</span>
        ) : (
          formatDuration(duration, intlLocaleFor(resolvedLocale))
        ),
    },
    {
      key: "trigger",
      label: t("workflowActivity.facts.trigger"),
      value: (
        <span title={run.triggerReason || undefined}>
          {labels.trigger(run.triggerType)}
          {run.triggerReason && <span className="text-muted-foreground"> · {run.triggerReason}</span>}
        </span>
      ),
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-lg bg-muted/35 px-3.5 py-3">
      {facts.map((fact) => (
        <div key={fact.key} className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">{fact.label}</dt>
          <dd className="mt-0.5 break-words text-sm tabular-nums [overflow-wrap:anywhere]">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function nodeDurationMs(node: WorkflowNodeRun, now: number) {
  return runDurationMs({ status: node.status, startedAt: node.startedAt, finishedAt: node.finishedAt }, now);
}

/** Compact ordered list of executed steps with per-step status and elapsed time. */
export function RunSteps({ nodeRuns }: { nodeRuns: WorkflowNodeRun[] }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const now = useNow(nodeRuns.some((node) => isActiveRunStatus(node.status)));
  if (nodeRuns.length === 0) return null;
  const ordered = [...nodeRuns].sort((left, right) => left.position - right.position || left.id - right.id);
  return (
    <section className="min-w-0 space-y-1.5" aria-label={t("workflowActivity.steps")}>
      <h4 className="text-xs font-medium text-muted-foreground">{t("workflowActivity.steps")}</h4>
      <ol className="min-w-0">
        {ordered.map((node, index) => {
          const duration = nodeDurationMs(node, now);
          const last = index === ordered.length - 1;
          return (
            <li key={node.id} className="relative flex min-w-0 gap-3 pb-2.5 last:pb-0">
              {!last && <span className="absolute left-[6.5px] top-4 h-[calc(100%-0.75rem)] w-px bg-border" />}
              <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
                <RunStatusDot status={node.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline justify-between gap-3">
                  <span
                    className={`min-w-0 truncate text-sm ${node.status === "skipped" ? "text-muted-foreground" : ""}`}
                  >
                    {node.displayName || node.nodeId}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {duration !== null
                      ? formatDuration(duration, intlLocaleFor(resolvedLocale))
                      : t(`workflowActivity.status.${node.status}`, { defaultValue: node.status })}
                  </span>
                </div>
                {node.errorMessage && (
                  <p className="mt-0.5 break-words text-xs text-error-foreground [overflow-wrap:anywhere]">
                    {node.errorMessage}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

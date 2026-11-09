import { CircleCheck, CircleDashed, Loader2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { WorkflowDefinition, WorkflowRun } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { isDemoShowcaseActiveRun, runTitle } from "./runPresentation";
import type { WorkflowPulseState } from "./useWorkflowOverview";
import { parseNodes } from "./workflowPageModel";

/**
 * How far an active run has come: finished jobs for bulk runs, otherwise the
 * stage now running out of the workflow's stages.
 */
export function activeRunProgress(run: WorkflowRun, stageCount: number) {
  if (run.status !== "running") return null;
  if (run.jobCount > 1) return { current: run.completedJobs, total: run.jobCount };
  const total = Math.max(stageCount, run.nodeRunCount);
  if (total === 0) return null;
  return { current: Math.min(run.completedNodeRuns + 1, total), total };
}

/**
 * The page's status strip: what is running now and what needs attention. Each
 * cell opens Activity on the matching list, which keeps the full queue; each
 * trigger states its own next start beside the workflow it starts.
 */
export function WorkflowPulse({
  pulse,
  definitions,
  onOpenActivity,
  onOpenAttention,
}: {
  pulse: WorkflowPulseState;
  definitions: WorkflowDefinition[];
  onOpenActivity: () => void;
  onOpenAttention: () => void;
}) {
  const { t } = useTranslation();
  const lead = pulse.active.find((run) => run.status === "running") ?? pulse.active[0] ?? null;
  const leadDefinition = lead ? definitions.find((definition) => definition.code === lead.workflowCode) : undefined;
  const progress = lead ? activeRunProgress(lead, parseNodes(leadDefinition?.definitionJson ?? "").length) : null;

  return (
    <section
      aria-label={t("workflowPage.console.statusStrip")}
      className="flex min-w-0 items-stretch overflow-hidden rounded-lg border bg-card"
      data-toast-avoid
    >
      <PulseCell
        className="min-w-0 flex-[1.6]"
        onClick={onOpenActivity}
        orb={
          <PulseOrb tone={lead ? "info" : "neutral"}>
            {lead && !isDemoShowcaseActiveRun(lead) ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : lead ? (
              <Loader2 className="h-4 w-4" aria-hidden />
            ) : (
              <CircleDashed className="h-4 w-4" aria-hidden />
            )}
          </PulseOrb>
        }
        label={lead ? t("workflowPage.console.now") : t("workflowPage.console.idle")}
        value={
          lead ? (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{runTitle(lead, t)}</span>
              {pulse.running > 1 && (
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {t("workflowPage.console.moreQueued", { count: pulse.running - 1 })}
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">{t("workflowPage.console.nothingRunning")}</span>
          )
        }
        detail={
          progress ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-info/15" aria-hidden>
                <span
                  className="block h-full rounded-full bg-info transition-[width]"
                  style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                />
              </span>
              <span className="truncate tabular-nums">
                {t("workflowPage.console.stepProgress", { current: progress.current, total: progress.total })}
              </span>
            </span>
          ) : lead ? (
            t(`workflowActivity.status.${lead.status}`, { defaultValue: lead.status })
          ) : null
        }
      />
      <PulseDivider />
      <PulseCell
        className="min-w-0 flex-1"
        onClick={onOpenAttention}
        orb={
          <PulseOrb tone={pulse.attention > 0 ? "warning" : "success"}>
            {pulse.attention > 0 ? (
              <TriangleAlert className="h-4 w-4" aria-hidden />
            ) : (
              <CircleCheck className="h-4 w-4" aria-hidden />
            )}
          </PulseOrb>
        }
        label={t("workflowPage.console.attention")}
        value={
          pulse.attention > 0 ? (
            <>
              <span className="tabular-nums xl:hidden">{pulse.attention}</span>
              <span className="hidden xl:inline">
                {t("workflowPage.console.attentionCount", { count: pulse.attention })}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">{t("workflowPage.console.allClear")}</span>
          )
        }
      />
    </section>
  );
}

const orbTone = {
  info: "bg-info-surface text-info-foreground",
  success: "bg-success-surface text-success-foreground",
  warning: "bg-warning-surface text-warning-foreground",
  neutral: "bg-muted text-muted-foreground",
} as const;

function PulseOrb({ tone, children }: { tone: keyof typeof orbTone; children: ReactNode }) {
  return <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", orbTone[tone])}>{children}</span>;
}

function PulseDivider({ className }: { className?: string }) {
  return <span aria-hidden className={cn("my-3 w-px shrink-0 bg-border", className)} />;
}

function PulseCell({
  orb,
  label,
  value,
  detail,
  className,
  onClick,
}: {
  orb: ReactNode;
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-16 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted/70 sm:px-4",
        className,
      )}
      onClick={onClick}
    >
      <span className="hidden sm:contents">{orb}</span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-2xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="min-w-0 truncate text-sm font-medium">{value}</span>
        {detail && <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
    </button>
  );
}

import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/features/workflows/WorkflowDetailLayout";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import type { TriggerSummary } from "@/features/workflows/workflowTriggerModel";

const intervalKey = {
  minutes: "workflowPage.operations.schedule.everyMinutes",
  hours: "workflowPage.operations.schedule.everyHours",
  days: "workflowPage.operations.schedule.everyDays",
} as const;

/**
 * What starts an operation on its own, in one line under its name: at
 * startup, after a scan, while watching folders, or on an interval with its
 * next run.
 * Nothing shows for an operation that runs only by hand.
 */
export function OperationSchedule({ summary }: { summary: TriggerSummary | null }) {
  const { t } = useTranslation();
  if (!summary) return null;
  if (summary.paused)
    return (
      <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{t("workflowPage.operations.schedule.paused")}</p>
    );
  const parts = [
    summary.startup ? t("workflowPage.operations.schedule.startup") : null,
    summary.after ? t(`workflowPage.operations.schedule.after.${summary.after}`) : null,
    summary.watching ? t("workflowPage.operations.schedule.watching") : null,
    ...summary.intervals.map((interval) => t(intervalKey[interval.unit], { count: interval.count })),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0 && !summary.nextRunAt) return null;
  return (
    <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-sm leading-5 text-muted-foreground">
      {parts.map((part, index) => (
        <span key={index} className="flex gap-x-1.5">
          {index > 0 && <span aria-hidden>·</span>}
          {part}
        </span>
      ))}
      {summary.nextRunAt && (
        <span className="flex gap-x-1.5">
          <span aria-hidden>·</span>
          <span>
            {workflowCopy("next")} <RelativeTime value={summary.nextRunAt} fallback="" />
          </span>
        </span>
      )}
    </p>
  );
}

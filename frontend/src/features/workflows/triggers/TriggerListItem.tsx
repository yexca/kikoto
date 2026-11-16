import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Switch } from "@/components/ui/switch";
import { RelativeTime } from "@/features/workflows/WorkflowDetailLayout";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { triggerRunsFull, workflowTriggerCondition } from "@/features/workflows/workflowTriggerModel";
import type { WorkflowTrigger } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

/**
 * One trigger as a row: an optional switch that pauses and resumes it, its
 * name, when it runs, whether in full, when it runs next or that it is
 * paused, its last error, and one action at the end. Where the name already
 * says when it runs, the condition is left out of the line below it.
 */
export function TriggerListItem({
  trigger,
  label,
  showCondition = true,
  toggle,
  action,
}: {
  trigger: WorkflowTrigger;
  label: string;
  showCondition?: boolean;
  /** The pause switch, or null for a trigger that is not switched here. */
  toggle: { disabled: boolean; onChange: (enabled: boolean) => void } | null;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const full = triggerRunsFull(trigger.workflowCode, trigger);
  const facts: ReactNode[] = [
    showCondition ? workflowTriggerCondition(trigger) : null,
    full ? t("workflowPage.cards.full") : null,
    !trigger.enabled ? (
      workflowCopy("paused")
    ) : trigger.triggerType === "schedule" && trigger.nextRunAt ? (
      <>
        {workflowCopy("next")} <RelativeTime value={trigger.nextRunAt} fallback="" />
      </>
    ) : null,
  ].filter((fact) => fact !== null);
  return (
    <li className="flex min-h-12 min-w-0 items-center gap-3 px-3 py-2">
      {toggle && (
        <Switch
          checked={trigger.enabled}
          disabled={toggle.disabled}
          onCheckedChange={toggle.onChange}
          aria-label={`${trigger.enabled ? workflowCopy("pause") : workflowCopy("enable")} ${label}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm font-medium", !trigger.enabled && "text-muted-foreground")}>{label}</div>
        {facts.length > 0 && (
          <div className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
            {facts.map((fact, index) => (
              <span key={index} className="flex gap-x-1.5">
                {index > 0 && <span aria-hidden>·</span>}
                <span>{fact}</span>
              </span>
            ))}
          </div>
        )}
        {trigger.lastErrorMessage && (
          <div className="mt-0.5 break-words text-xs text-error-foreground [overflow-wrap:anywhere]">
            {workflowCopy("lastError")}: {trigger.lastErrorMessage}
          </div>
        )}
      </div>
      {action}
    </li>
  );
}

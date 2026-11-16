import { ArrowUpRight, Edit3, Eye } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { nowSectionLimit, NowSection, ShowAllButton } from "@/features/workflows/runs/NowRuns";
import { RelativeTime } from "@/features/workflows/WorkflowDetailLayout";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { nextTriggerOrder, triggerRunsFull, workflowTriggerCondition } from "@/features/workflows/workflowTriggerModel";
import type { WorkflowTrigger } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

/** How Next shows one workflow's triggers. */
export type NextTriggerOwner = {
  name: string;
  /** The trigger is one of the operations', so it is switched and edited here. */
  editable: boolean;
  /** Where a trigger edited elsewhere is configured, such as Discover or the source's settings. */
  path: string | null;
};

/**
 * What runs on its own next, for every workflow: interval schedules by their
 * next run, then startup and folder triggers, and paused triggers last. The
 * operations' triggers are switched on and off and edited here; another
 * workflow's lead to where they are configured.
 */
export function NextTriggers({
  triggers,
  ownerOf,
  canManage,
  readOnly,
  loading,
  onToggle,
  onEdit,
  onOpenPath,
}: {
  triggers: WorkflowTrigger[];
  ownerOf: (trigger: WorkflowTrigger) => NextTriggerOwner;
  canManage: boolean;
  /** Demo keeps the controls visible and opens the operations' triggers read-only. */
  readOnly: boolean;
  loading: boolean;
  onToggle: (trigger: WorkflowTrigger, enabled: boolean) => void;
  onEdit: (trigger: WorkflowTrigger) => void;
  onOpenPath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const ordered = nextTriggerOrder(triggers);
  const shown = expanded ? ordered : ordered.slice(0, nowSectionLimit);
  return (
    <NowSection title={t("workflowPage.runs.next")}>
      {ordered.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          {loading ? t("workManagement.loading") : t("workflowPage.runs.nothingNext")}
        </p>
      ) : (
        <ul className="divide-y">
          {shown.map((trigger) => {
            const owner = ownerOf(trigger);
            const switchable = owner.editable && canManage && !readOnly;
            const full = triggerRunsFull(trigger.workflowCode, trigger);
            // Another workflow's trigger adds its own name, such as which ranking it pulls, unless it repeats the workflow's.
            const label =
              owner.editable || !trigger.displayName.trim() || trigger.displayName.trim() === owner.name
                ? owner.name
                : `${owner.name} · ${trigger.displayName}`;
            return (
              <li key={trigger.id} className="flex min-h-12 min-w-0 items-center gap-3 px-3 py-2">
                {owner.editable && (
                  <Switch
                    checked={trigger.enabled}
                    disabled={!switchable}
                    onCheckedChange={(enabled) => onToggle(trigger, enabled)}
                    aria-label={`${trigger.enabled ? workflowCopy("pause") : workflowCopy("enable")} ${label}`}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className={cn("truncate text-sm font-medium", !trigger.enabled && "text-muted-foreground")}>
                    {label}
                  </div>
                  <div className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                    <span>{workflowTriggerCondition(trigger)}</span>
                    {full && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{t("workflowPage.cards.full")}</span>
                      </>
                    )}
                    {!trigger.enabled ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>{workflowCopy("paused")}</span>
                      </>
                    ) : (
                      trigger.triggerType === "schedule" &&
                      trigger.nextRunAt && (
                        <>
                          <span aria-hidden>·</span>
                          <span>
                            {workflowCopy("next")} <RelativeTime value={trigger.nextRunAt} fallback="" />
                          </span>
                        </>
                      )
                    )}
                  </div>
                  {trigger.lastErrorMessage && (
                    <div className="mt-0.5 break-words text-xs text-error-foreground [overflow-wrap:anywhere]">
                      {workflowCopy("lastError")}: {trigger.lastErrorMessage}
                    </div>
                  )}
                </div>
                {owner.editable && (canManage || readOnly) ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground"
                    title={readOnly ? workflowCopy("viewTrigger", { name: label }) : t("workflowPage.triggers.edit")}
                    aria-label={
                      readOnly
                        ? workflowCopy("viewTrigger", { name: label })
                        : `${t("workflowPage.triggers.edit")} ${label}`
                    }
                    onClick={() => onEdit(trigger)}
                  >
                    {readOnly ? <Eye className="h-4 w-4" /> : <Edit3 className="h-4 w-4" />}
                  </Button>
                ) : owner.path ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground"
                    title={t("workflowPage.triggers.openOwner")}
                    aria-label={`${t("workflowPage.triggers.openOwner")} ${label}`}
                    onClick={() => onOpenPath(owner.path as string)}
                  >
                    <ArrowUpRight className="h-4 w-4" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {nowSectionLimit < ordered.length && (
        <ShowAllButton expanded={expanded} total={ordered.length} onToggle={setExpanded} />
      )}
    </NowSection>
  );
}

import { CalendarClock, Loader2, Play, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { TriggerSummary } from "@/features/workflows/workflowTriggerModel";
import type { WorkflowRun } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import type { OperationState } from "./operationModel";
import { OperationSchedule } from "./OperationSchedule";
import { OperationStatus } from "./OperationStatus";

/**
 * One operation as a card: its name, what starts it on its own, its state,
 * and Run. The trigger button at the end of its name row opens what starts it
 * on its own and is lit while any of that is on. An operation that runs incrementally offers Full beside Run,
 * which applies to the next run only. An operation with options of its own
 * opens them from the button beside its name and names them while they differ
 * from the defaults.
 */
export function OperationCard({
  code,
  icon: Icon,
  name,
  schedule,
  state,
  moreActive,
  stageCount,
  locked,
  runAllowed,
  runBlockedReason,
  full,
  options,
  triggers,
  onRun,
  onOpenRun,
}: {
  code: string;
  icon: LucideIcon;
  name: string;
  /** What starts the operation on its own; null when it runs only by hand. */
  schedule: TriggerSummary | null;
  state: OperationState;
  moreActive: number;
  stageCount: number;
  /** The operation cannot be started now, such as while its run is active. */
  locked: boolean;
  runAllowed: boolean;
  /** Why Run is unavailable, as its tooltip. */
  runBlockedReason?: string;
  /** The next run's Full choice, or null for an operation that always runs in full. */
  full: { checked: boolean; hint: string; onChange: (checked: boolean) => void } | null;
  /** The operation's own options: the button's name, what they change from the defaults, and how to open them. */
  options?: { label: string; summary: string | null; onOpen: () => void };
  /** The trigger button; without onOpen it only shows whether a trigger is on. */
  triggers: { label: string; onOpen?: () => void };
  onRun: () => void;
  onOpenRun: (run: WorkflowRun) => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const fullId = useId();
  // Lit while any trigger is on; the schedule line says which, or that they are paused.
  const triggerTone = schedule && !schedule.paused ? "text-primary" : "text-muted-foreground";
  const busyLabel =
    state.phase === "queued"
      ? t("workflowActivity.status.queued")
      : state.phase === "running"
        ? t("workflowActivity.status.running")
        : t("workflowPage.operations.status.starting");

  return (
    <li
      role="group"
      aria-labelledby={nameId}
      data-operation={code}
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <h3 id={nameId} className="min-w-0 flex-1 text-sm font-semibold leading-5">
          {name}
        </h3>
        <div className="-mr-1.5 -mt-1 flex shrink-0 items-center gap-0.5">
          {options && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              title={options.label}
              aria-label={options.label}
              onClick={options.onOpen}
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {triggers.onOpen ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className={triggerTone}
              title={triggers.label}
              aria-label={triggers.label}
              onClick={triggers.onOpen}
            >
              <CalendarClock className="h-4 w-4" aria-hidden />
            </Button>
          ) : (
            <span
              role="img"
              className={cn("inline-flex h-8 w-8 items-center justify-center", triggerTone)}
              title={triggers.label}
              aria-label={triggers.label}
            >
              <CalendarClock className="h-4 w-4" aria-hidden />
            </span>
          )}
        </div>
      </div>
      <div className="min-w-0 pl-8">
        <OperationStatus state={state} moreActive={moreActive} stageCount={stageCount} onOpenRun={onOpenRun} />
        <OperationSchedule summary={schedule} />
        {options?.summary && <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{options.summary}</p>}
      </div>
      <div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t pt-3">
        {full && (
          <div className="flex min-w-0 items-center gap-2">
            <Switch
              id={fullId}
              checked={full.checked}
              disabled={!runAllowed || locked}
              onCheckedChange={full.onChange}
              aria-describedby={full.checked ? `${fullId}-hint` : undefined}
            />
            <label htmlFor={fullId} className="text-sm">
              {t("workflowPage.cards.full")}
            </label>
          </div>
        )}
        {locked ? (
          <Button size="sm" variant="outline" className="ml-auto min-w-[5.5rem]" disabled>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {busyLabel}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto min-w-[5.5rem]"
            disabled={!runAllowed}
            title={runAllowed ? undefined : runBlockedReason}
            onClick={onRun}
          >
            <Play className="h-4 w-4" aria-hidden />
            {t("workflowPage.run")}
          </Button>
        )}
        {full?.checked && (
          <p id={`${fullId}-hint`} className="basis-full text-xs text-warning-foreground">
            {full.hint}
          </p>
        )}
      </div>
    </li>
  );
}

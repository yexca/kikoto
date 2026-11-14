import { ChevronDown, Loader2, Play, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { WorkflowRun } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import type { OperationState } from "./operationModel";
import { OperationStatus } from "./OperationStatus";

/**
 * One operation. At rest it is a name, one sentence, its state, and one run
 * control; its options, schedule, and run history open below it on demand.
 */
export function OperationRow({
  code,
  icon: Icon,
  name,
  summary,
  state,
  moreActive,
  locked,
  stageCount,
  expanded,
  needsInput,
  runAllowed,
  runBlockedReason,
  onRun,
  onToggle,
  onOpenRun,
  children,
}: {
  code: string;
  icon: LucideIcon;
  name: string;
  summary: string;
  state: OperationState;
  moreActive: number;
  /** The operation cannot be started now, such as while an exclusive operation runs. */
  locked: boolean;
  stageCount: number;
  expanded: boolean;
  /** The operation needs an input, such as a work code, so its run control opens the options. */
  needsInput: boolean;
  runAllowed: boolean;
  /** Why the run control is unavailable, as its tooltip. */
  runBlockedReason?: string;
  onRun: () => void;
  onToggle: (open: boolean) => void;
  onOpenRun: (run: WorkflowRun) => void;
  /** The options area, rendered only while expanded. */
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const panelId = useId();
  const headerRef = useRef<HTMLDivElement>(null);

  // An operation opened by a link shows itself; one opened in place is already in view and does not move.
  useEffect(() => {
    if (expanded) headerRef.current?.scrollIntoView({ block: "nearest" });
  }, [expanded]);

  const busyLabel =
    state.phase === "queued"
      ? t("workflowActivity.status.queued")
      : state.phase === "running"
        ? t("workflowActivity.status.running")
        : t("workflowPage.operations.status.starting");

  return (
    <li>
      <div role="group" aria-labelledby={nameId} data-operation={code}>
        <div
          ref={headerRef}
          className="flex scroll-mt-20 flex-wrap items-start gap-x-3 gap-y-1.5 py-3.5 md:items-center"
        >
          <Icon className="order-1 mt-0.5 h-5 w-5 shrink-0 text-muted-foreground md:mt-0" aria-hidden />
          <div className="order-2 min-w-0 flex-1">
            <h3 id={nameId} className="text-sm font-medium leading-5">
              {name}
            </h3>
            <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{summary}</p>
          </div>
          <OperationStatus
            state={state}
            moreActive={moreActive}
            stageCount={stageCount}
            onOpenRun={onOpenRun}
            className="order-4 basis-full pl-8 md:order-3 md:w-72 md:basis-auto md:pl-0"
          />
          <div className="order-3 flex shrink-0 items-center gap-1 md:order-4">
            {/* While the options are open their own run bar holds Run, next to what it will use. */}
            {!expanded &&
              (locked ? (
                <Button size="sm" variant="outline" className="min-w-[5.5rem]" disabled>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  {busyLabel}
                </Button>
              ) : needsInput ? (
                <Button size="sm" variant="outline" className="min-w-[5.5rem]" onClick={() => onToggle(true)}>
                  <Play className="h-4 w-4" aria-hidden />
                  {t("workflowPage.operations.runWithOptions")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="min-w-[5.5rem]"
                  disabled={!runAllowed}
                  title={runAllowed ? undefined : runBlockedReason}
                  onClick={onRun}
                >
                  <Play className="h-4 w-4" aria-hidden />
                  {t("workflowPage.run")}
                </Button>
              ))}
            <Button
              size="sm"
              variant="ghost"
              className="px-2 text-muted-foreground"
              aria-expanded={expanded}
              aria-controls={panelId}
              title={t("workflowPage.operations.options")}
              onClick={() => onToggle(!expanded)}
            >
              <span className="max-sm:sr-only">{t("workflowPage.operations.options")}</span>
              <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden />
            </Button>
          </div>
        </div>
        {expanded && (
          <div id={panelId} className="min-w-0 pb-6 md:pl-8">
            {children}
          </div>
        )}
      </div>
    </li>
  );
}

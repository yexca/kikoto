import type { ReactNode } from "react";

import type { WorkflowDefinition } from "@/lib/api";

import { localizedWorkflowDefinition, workflowCopy } from "./workflowPageModel";
import { WorkflowRunSlotTarget } from "./WorkflowRunSlot";
import { workflowIcon } from "./workflowVisuals";

/** The selected workflow's identity: what it is and what it does. The Run action lands in the header slot. */
export function WorkflowDetailFrame({ definition, children }: { definition: WorkflowDefinition; children: ReactNode }) {
  const display = localizedWorkflowDefinition(definition);
  const Icon = workflowIcon(definition.code);
  return (
    <div className="min-w-0 space-y-5">
      <header className="flex min-w-0 items-start gap-4">
        <span className="hidden h-12 w-12 shrink-0 place-items-center rounded-lg border bg-card text-primary sm:grid">
          <Icon className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-xl font-semibold leading-7 tracking-tight">{display.displayName}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {display.description || workflowCopy("noDescription")}
          </p>
        </div>
        <WorkflowRunSlotTarget />
      </header>
      {children}
    </div>
  );
}

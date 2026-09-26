import type { ReactNode, RefObject } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { workflowCopy } from "@/features/workflows/workflowPageModel";

export function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export function WorkflowMetadataLoadingState() {
  return (
    <Card className="min-h-72" role="status" aria-label={workflowCopy("loadingWorkflowData")} aria-busy="true">
      <CardContent className="flex min-h-72 flex-col justify-center gap-3 p-6">
        <SkeletonLine className="h-5 w-40" />
        <SkeletonLine className="h-4 w-72 max-w-full" />
        <SkeletonLine className="h-32 w-full" />
      </CardContent>
    </Card>
  );
}

export function WorkflowMetadataErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="min-h-72 border-error-border" role="alert">
      <CardContent className="grid min-h-72 place-items-center p-6 text-center">
        <div>
          <p className="text-sm text-error-foreground">{message}</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
            {workflowCopy("retry")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function Modal({
  title,
  children,
  onClose,
  dismissible = false,
  anchorRef,
  popoverClassName,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  popoverClassName?: string;
}) {
  if (anchorRef) {
    return (
      <AnchoredPopover
        open
        anchorRef={anchorRef}
        ariaLabel={title}
        className={`${popoverClassName ?? "w-[min(42rem,calc(100vw-1.5rem))]"} p-0`}
        floatingLayer
        dismissOnOutsidePointer={dismissible}
        onOpenChange={(open) => {
          if (!open && dismissible) onClose();
        }}
      >
        <DialogHeader title={title} onClose={onClose} closeLabel={workflowCopy("close")} />
        <div className="app-scrollbar max-h-[min(70dvh,42rem)] overflow-y-auto px-5 py-4">{children}</div>
      </AnchoredPopover>
    );
  }
  return (
    <Dialog onClose={onClose} size="xl" dismissible={dismissible} className="max-w-3xl">
      <DialogHeader title={title} onClose={onClose} closeLabel={workflowCopy("close")} />
      <DialogBody>{children}</DialogBody>
    </Dialog>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

export function EmptyPanel({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="p-5 text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}

export function ErrorPanel({ error }: { error: string }) {
  return (
    <div className="min-w-0 break-words rounded-md border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground [overflow-wrap:anywhere]">
      {error}
    </div>
  );
}

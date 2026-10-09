import { Loader2 } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toastFromError, useToast } from "@/components/ui/toast";
import { CandidateReviewCard } from "@/features/workflows/RunCandidateReview";
import { RunDiagnostics } from "@/features/workflows/RunDiagnostics";
import { RunFetchFiles } from "@/features/workflows/RunFetchFiles";
import { RunFacts, RunStatusBadge, RunSteps } from "@/features/workflows/RunOverview";
import { isDemoShowcaseActiveRun, runTitle } from "@/features/workflows/runPresentation";
import { RunTransferProgress } from "@/features/workflows/RunTransferProgress";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { SkeletonLine } from "@/features/workflows/WorkflowPanelParts";
import { usePendingAction } from "@/hooks/usePendingAction";
import i18n from "@/i18n";
import { api, type WorkflowCandidate, type WorkflowEvent, type WorkflowRun, type WorkflowRunDetail } from "@/lib/api";
import { openMetadataIssues } from "@/lib/metadataMaintenance";

export function RunDetail({
  run,
  candidates,
  events,
  loading = false,
  onCandidateUpdate,
  onRunAction,
  readOnly,
  canSyncMetadata,
}: {
  run: WorkflowRunDetail | WorkflowRun | null;
  candidates: WorkflowCandidate[];
  events: WorkflowEvent[];
  loading?: boolean;
  onCandidateUpdate: () => Promise<void>;
  onRunAction: () => Promise<void>;
  readOnly: boolean;
  canSyncMetadata: boolean;
}) {
  const { t } = useTranslation();
  if (!run) {
    return loading ? (
      <RunDetailSkeleton />
    ) : (
      <p className="py-6 text-center text-sm text-muted-foreground">{workflowCopy("selectRunNodeDetail")}</p>
    );
  }
  const nodeRuns = "nodeRuns" in run ? run.nodeRuns : [];
  return (
    <div className="min-w-0 space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="min-w-0 break-words text-base font-semibold leading-6">
            {run.workflowCode === "remote_work_fetch" ? runTitle(run, t) : run.displayName}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <RunStatusBadge status={run.status} />
            <span className="tabular-nums">#{run.id}</span>
          </div>
        </div>
        {!readOnly && <RunActions run={run} onRunAction={onRunAction} />}
      </header>
      {!loading && <RunTransferProgress run={run} />}
      {!loading && run.workflowCode === "remote_work_fetch" && <RunFetchFiles key={run.id} run={run} />}
      <RunFacts run={run} />
      <RunStats run={run} />
      {"metadataIssues" in run && run.metadataIssues && run.metadataIssues.encountered > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
          <p className="min-w-0">
            {i18n.t(run.metadataIssues.pending > 0 ? "metadataIssues.pendingForRun" : "metadataIssues.resolvedForRun", {
              count: run.metadataIssues.pending,
            })}
          </p>
          {canSyncMetadata && run.metadataIssues.pending > 0 && (
            <Button size="sm" variant="outline" onClick={() => openMetadataIssues(run.id)}>
              {i18n.t("metadataIssues.openIssues")}
            </Button>
          )}
        </div>
      )}
      {!loading && candidates.length > 0 && (
        <RunItems candidates={candidates} onCandidateUpdate={onCandidateUpdate} readOnly={readOnly} />
      )}
      {!loading && <RunSteps nodeRuns={nodeRuns} demoShowcase={isDemoShowcaseActiveRun(run)} />}
      {!loading && <RunDiagnostics events={events} nodeRuns={nodeRuns} summaryJson={run.summaryJson} />}
    </div>
  );
}

function RunDetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SkeletonLine className="h-5 w-48 max-w-full" />
          <SkeletonLine className="h-5 w-16" />
        </div>
        <SkeletonLine className="h-3 w-64 max-w-full" />
        <SkeletonLine className="h-3 w-56 max-w-full" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonLine key={index} className="h-6 w-20" />
        ))}
      </div>
      <SkeletonLine className="h-16 w-full" />
    </div>
  );
}

function RunStats({ run }: { run: WorkflowRun }) {
  const review = pendingReviewCount(run);
  const failed = run.failedNodeRuns + run.failedJobs;
  const skipped = run.skippedNodeRuns + run.skippedJobs;
  const stats: Array<{ key: string; value: string; label: string; tone?: "warning" | "error" }> = [
    { key: "nodes", value: `${run.completedNodeRuns}/${run.nodeRunCount}`, label: workflowCopy("nodes") },
    { key: "jobs", value: `${run.completedJobs}/${run.jobCount}`, label: workflowCopy("jobs") },
  ];
  if (review > 0)
    stats.push({ key: "review", value: `${review}`, label: workflowCopy("pendingReview"), tone: "warning" });
  if (failed > 0) stats.push({ key: "failed", value: `${failed}`, label: workflowCopy("failedItems"), tone: "error" });
  if (skipped > 0) stats.push({ key: "skipped", value: `${skipped}`, label: workflowCopy("skipped") });
  return (
    <dl className="flex flex-wrap gap-1.5 text-xs">
      {stats.map((stat) => (
        <div
          key={stat.key}
          className={`inline-flex items-baseline gap-1 rounded-md px-2 py-1 ${
            stat.tone === "error"
              ? "bg-error-surface text-error-foreground"
              : stat.tone === "warning"
                ? "bg-warning-surface text-warning-foreground"
                : "bg-muted/50"
          }`}
        >
          <dt className={`order-2 ${stat.tone ? "" : "text-muted-foreground"}`}>{stat.label}</dt>
          <dd className="order-1 font-semibold tabular-nums">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RunItems({
  candidates,
  onCandidateUpdate,
  readOnly,
}: {
  candidates: WorkflowCandidate[];
  onCandidateUpdate: () => Promise<void>;
  readOnly: boolean;
}) {
  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">{workflowCopy("noReviewableItems")}</p>;
  }
  return (
    <section className="min-w-0 space-y-2">
      <h4 className="text-xs font-semibold text-muted-foreground">
        {workflowCopy("candidates")} · {candidates.length}
      </h4>
      <div className="min-w-0 divide-y rounded-md border">
        {candidates.map((candidate) => (
          <CandidateReviewCard
            key={candidate.id}
            candidate={candidate}
            onCandidateUpdate={onCandidateUpdate}
            readOnly={readOnly}
          />
        ))}
      </div>
    </section>
  );
}

function RunActions({ run, onRunAction }: { run: WorkflowRun; onRunAction: () => Promise<void> }) {
  const toast = useToast();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const { pending, run: runAction } = usePendingAction<"cancel" | "retry">();
  const cancellable = ["queued", "running"].includes(run.status);
  const destructiveCleanup = [
    "media_location_cleanup",
    "media_cleanup_forget_work",
    "media_cache_cleanup",
    "media_cache_limit_cleanup",
    "cache_orphan_cleanup",
    "local_media_delete",
    "local_location_cleanup",
  ].includes(run.workflowCode);
  const retryable =
    (run.status === "failed" ||
      (run.status === "partial" && run.workflowCode === "remote_work_fetch" && run.pendingCandidates > 0)) &&
    [
      "local_library_scan",
      "local_media_index",
      "metadata_sync",
      "remote_work_fetch",
      "media_cache",
      "media_cache_cleanup",
      "media_location_cleanup",
      "media_cleanup_forget_work",
      "local_media_delete",
      "local_location_cleanup",
      "remote_popular_collection",
      "source_presence_check",
    ].includes(run.workflowCode);
  if (!cancellable && !retryable) {
    return null;
  }
  const cancel = () =>
    runAction(
      "cancel",
      async () => {
        await api.cancelWorkflowRun(run.id);
        setConfirmingCancel(false);
        await onRunAction();
      },
      (error) => toast.notify(toastFromError(error, workflowCopy("runCancelFailed"))),
    );
  const retry = () =>
    runAction(
      "retry",
      async () => {
        await api.retryWorkflowRun(run.id);
        await onRunAction();
      },
      (error) => toast.notify(toastFromError(error, workflowCopy("runRetryFailed"))),
    );
  const closeConfirmation = () => {
    if (!pending) setConfirmingCancel(false);
  };
  return (
    <>
      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
        {cancellable && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            aria-busy={pending === "cancel"}
            onClick={() => {
              if (destructiveCleanup) setConfirmingCancel(true);
              else void cancel();
            }}
          >
            {pending === "cancel" && !confirmingCancel && <Loader2 className="h-4 w-4 animate-spin" />}
            {workflowCopy("cancel")}
          </Button>
        )}
        {retryable && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            aria-busy={pending === "retry"}
            onClick={() => void retry()}
          >
            {pending === "retry" && <Loader2 className="h-4 w-4 animate-spin" />}
            {workflowCopy("retry")}
          </Button>
        )}
      </div>
      {confirmingCancel &&
        // Portaled: the Activity popover's backdrop-filter would otherwise contain this fixed overlay.
        createPortal(
          <Dialog onClose={closeConfirmation} size="md" dismissible={false}>
            <DialogHeader
              title={workflowCopy("cancelDeletionTitle")}
              onClose={closeConfirmation}
              closeLabel={workflowCopy("close")}
            >
              <p className="mt-2 text-sm text-muted-foreground">{workflowCopy("cancelDeletionDescription")}</p>
              {run.workflowCode === "media_cleanup_forget_work" && (
                <p className="mt-2 text-sm text-muted-foreground">{workflowCopy("forgetStepSkipped")}</p>
              )}
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" disabled={pending !== null} onClick={closeConfirmation}>
                {workflowCopy("keepRunning")}
              </Button>
              <Button
                variant="destructive"
                disabled={pending !== null}
                aria-busy={pending === "cancel"}
                onClick={() => void cancel()}
              >
                {pending === "cancel" && <Loader2 className="h-4 w-4 animate-spin" />}
                {workflowCopy("cancelWorkflow")}
              </Button>
            </DialogFooter>
          </Dialog>,
          document.body,
        )}
    </>
  );
}

function pendingReviewCount(run: WorkflowRun) {
  return run.pendingCandidates;
}

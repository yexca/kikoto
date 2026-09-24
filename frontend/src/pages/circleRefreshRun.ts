import type { TFunction } from "i18next";
import { useEffect, useRef } from "react";

import { isActiveRunStatus } from "@/features/workflows/runPresentation";
import { useStableCallback } from "@/hooks/useStableCallback";
import { useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import type { CreatorRefreshRun, WorkflowRunDetail } from "@/lib/api";

const fallbackPollMs = 5_000;

/**
 * Follows the circle's queued refresh run until it settles. Viewers who may
 * open Activity watch the run itself; others re-read the circle, whose detail
 * carries the latest run status.
 */
export function useCircleRefreshRun({
  run,
  canWatchRuns,
  onPoll,
  onSettled,
}: {
  run: CreatorRefreshRun | null | undefined;
  canWatchRuns: boolean;
  onPoll: () => void;
  onSettled: (run: CreatorRefreshRun, detail: WorkflowRunDetail | null) => void;
}) {
  const activeRunId = run && isActiveRunStatus(run.status) ? run.runId : null;
  const watcher = useWorkflowRunWatcher(canWatchRuns ? activeRunId : null);
  const followedRunId = useRef<number | null>(null);
  const settledRunId = useRef<number | null>(null);
  const poll = useStableCallback(onPoll);
  const settle = useStableCallback(onSettled);

  useEffect(() => {
    if (activeRunId) followedRunId.current = activeRunId;
  }, [activeRunId]);

  // A watched run settles before the circle is re-read.
  useEffect(() => {
    const detail = watcher.run;
    if (!run || !detail || detail.id !== activeRunId || isActiveRunStatus(detail.status)) return;
    if (settledRunId.current === detail.id) return;
    settledRunId.current = detail.id;
    settle({ ...run, status: detail.status }, detail);
  }, [activeRunId, run, settle, watcher.run]);

  // Without run access, the re-read circle reports the settled status.
  useEffect(() => {
    if (!run || isActiveRunStatus(run.status) || followedRunId.current !== run.runId) return;
    if (settledRunId.current === run.runId) return;
    settledRunId.current = run.runId;
    settle(run, null);
  }, [run, settle]);

  useEffect(() => {
    if (!activeRunId || canWatchRuns) return;
    const timer = window.setInterval(poll, fallbackPollMs);
    return () => window.clearInterval(timer);
  }, [activeRunId, canWatchRuns, poll]);

  return { active: activeRunId !== null };
}

/** Describes a settled circle refresh; the run itself holds the step details. */
export function circleRefreshSettledMessage(run: CreatorRefreshRun, t: TFunction) {
  if (run.status === "failed") return t("creatorBrowse.circleRefreshFailed", { id: run.runId });
  if (run.status === "partial") return t("creatorBrowse.circleRefreshPartial", { id: run.runId });
  return t("creatorBrowse.circleRefreshFinished", { id: run.runId });
}

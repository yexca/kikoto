import { metadataSyncDefaultValues, metadataSyncPayload } from "@/features/workflows/metadataSyncModel";
import { isActiveRunStatus, runStatusTone, type RunTone } from "@/features/workflows/runPresentation";
import type { SystemRunKind, SystemRunOptions } from "@/features/workflows/workflowPageModel";
import type { WorkflowDefinition, WorkflowRun } from "@/lib/api";

/** What the Workflows page offers: the operations a person starts by hand, grouped by what they are for. */

export const operationGroups = ["library"] as const;

export type OperationGroup = (typeof operationGroups)[number];

type OperationSpec = {
  group: OperationGroup;
  kind: SystemRunKind;
  /** The options an untouched run form would send, which Run on the row uses. */
  defaults: () => SystemRunOptions;
  /**
   * The operation has one run queued or running at a time, so it cannot start
   * again until that run ends. Any other operation runs per target, such as a
   * metadata scope, and can start a run for another target while one is
   * active.
   */
  exclusive?: boolean;
};

/** Built-in operations in page order. */
const builtInOperations: Record<string, OperationSpec> = {
  local_library_scan: {
    group: "library",
    kind: "local_scan",
    exclusive: true,
    defaults: () => ({ followUpRun: false }),
  },
  local_media_index: {
    group: "library",
    kind: "local_media_index",
    exclusive: true,
    defaults: () => ({ localMediaIndexMode: "incremental" }),
  },
  metadata_sync: {
    group: "library",
    kind: "metadata_sync",
    defaults: () => ({ metadataSync: metadataSyncPayload(metadataSyncDefaultValues()) }),
  },
};

const operationOrder = ["local_library_scan", "local_media_index", "metadata_sync"];

export type Operation = OperationSpec & { definition: WorkflowDefinition };

export type OperationGroupEntry = { group: OperationGroup; operations: Operation[] };

/**
 * The operations among the workflow definitions. Workflows started from
 * another page (Fetch from a work, a catalog sync from its circle, series, or
 * voice actor, a source's library work check from its settings, and the
 * Discover workflows) and system workflows nobody starts by hand are not
 * operations; their runs are in Activity.
 */
export function operationsFromDefinitions(definitions: WorkflowDefinition[]): Operation[] {
  const rank = (code: string) => {
    const index = operationOrder.indexOf(code);
    return index < 0 ? operationOrder.length : index;
  };
  return definitions
    .flatMap((definition): Operation[] => {
      const builtIn = builtInOperations[definition.code];
      return builtIn ? [{ ...builtIn, definition }] : [];
    })
    .sort(
      (left, right) =>
        rank(left.definition.code) - rank(right.definition.code) || left.definition.id - right.definition.id,
    );
}

/** Groups in page order, omitting a group without an operation. */
export function groupOperations(operations: Operation[]): OperationGroupEntry[] {
  return operationGroups
    .map((group) => ({ group, operations: operations.filter((operation) => operation.group === group) }))
    .filter((entry) => entry.operations.length > 0);
}

export type RunProgress = { current: number; total: number; unit: "jobs" | "steps" };

/**
 * How far an active run has come: finished jobs for bulk runs, otherwise the
 * stage now running out of the workflow's stages.
 */
export function activeRunProgress(run: WorkflowRun, stageCount: number): RunProgress | null {
  if (run.status !== "running") return null;
  if (run.jobCount > 1) return { current: run.completedJobs, total: run.jobCount, unit: "jobs" };
  const total = Math.max(stageCount, run.nodeRunCount);
  if (total === 0) return null;
  return { current: Math.min(run.completedNodeRuns + 1, total), total, unit: "steps" };
}

export type OperationState =
  /** The latest run is not known yet. */
  | { phase: "loading" }
  | { phase: "never" }
  /** A run was requested here and is not listed yet. */
  | { phase: "starting" }
  | { phase: "queued"; run: WorkflowRun }
  | { phase: "running"; run: WorkflowRun }
  /** The latest run ended; `review` marks an outcome that still waits for a decision. */
  | { phase: "finished"; run: WorkflowRun; tone: RunTone; review: boolean };

/**
 * An operation's state from its newest run. A run requested on this page
 * counts as starting until a run at least as new is listed, so the row never
 * falls back to the previous outcome between the request and the next poll.
 */
export function operationState(
  run: WorkflowRun | null | undefined,
  pending: { runId: number | null } | undefined,
): OperationState {
  if (pending && (pending.runId === null || !run || run.id < pending.runId)) return { phase: "starting" };
  if (run === undefined) return { phase: "loading" };
  if (run === null) return { phase: "never" };
  if (run.status === "queued") return { phase: "queued", run };
  if (isActiveRunStatus(run.status)) return { phase: "running", run };
  return {
    phase: "finished",
    run,
    tone: runStatusTone(run.status),
    review: run.pendingCandidates > 0 || (run.pendingFailedMetadata ?? 0) > 0,
  };
}

/** The operation has a run starting, queued, or running. */
export function operationBusy(state: OperationState) {
  return state.phase === "starting" || state.phase === "queued" || state.phase === "running";
}

/**
 * Whether the operation cannot be started now. An exclusive operation waits
 * for its active run to end; any other waits only until the run it just
 * requested is listed, so one click queues one run.
 */
export function operationLocked(operation: Pick<OperationSpec, "exclusive">, state: OperationState) {
  return operation.exclusive ? operationBusy(state) : state.phase === "starting";
}

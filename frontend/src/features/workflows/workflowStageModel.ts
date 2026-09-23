import type { WorkflowEvent, WorkflowNodeRun } from "@/lib/api";

import { parseWorkflowTimestamp } from "./runPresentation";

export type WorkflowStageState = "idle" | "queued" | "running" | "succeeded" | "partial" | "failed" | "skipped";

export type WorkflowStageDefinition = { id: string; type: string; displayName?: string };

export type WorkflowStage = {
  id: string;
  title: string;
  type: string;
  state: WorkflowStageState;
  startedAt: string;
  finishedAt: string;
  errorMessage: string;
};

const knownStates = new Set<WorkflowStageState>(["queued", "running", "succeeded", "partial", "failed", "skipped"]);

export function workflowStageState(status: string | null | undefined): WorkflowStageState {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase() as WorkflowStageState;
  return knownStates.has(normalized) ? normalized : "idle";
}

function orderedNodeRuns(nodeRuns: WorkflowNodeRun[]) {
  return [...nodeRuns].sort((left, right) => left.position - right.position || left.id - right.id);
}

function stageFromNodeRun(node: WorkflowNodeRun): WorkflowStage {
  return {
    id: node.nodeId || String(node.id),
    title: node.displayName || node.nodeId,
    type: node.nodeType,
    state: workflowStageState(node.status),
    startedAt: node.startedAt,
    finishedAt: node.finishedAt,
    errorMessage: node.errorMessage,
  };
}

/**
 * Projects a run's node executions onto the definition's fixed stages. A run that recorded a node
 * more than once reports its latest attempt. Without definition stages, the run itself supplies
 * the stage list so a linked run for an unknown definition still reads as a pipeline.
 */
export function workflowStages(definition: WorkflowStageDefinition[], nodeRuns: WorkflowNodeRun[] = []) {
  const ordered = orderedNodeRuns(nodeRuns);
  if (definition.length === 0) return ordered.map(stageFromNodeRun);
  const latestByNodeID = new Map<string, WorkflowNodeRun>();
  ordered.forEach((node) => latestByNodeID.set(node.nodeId, node));
  return definition.map<WorkflowStage>((node) => {
    const run = latestByNodeID.get(node.id);
    return {
      id: node.id,
      title: node.displayName || run?.displayName || node.id,
      type: node.type,
      state: workflowStageState(run?.status),
      startedAt: run?.startedAt ?? "",
      finishedAt: run?.finishedAt ?? "",
      errorMessage: run?.errorMessage ?? "",
    };
  });
}

export type WorkflowLogLevel = "info" | "warn" | "error";

export type WorkflowLogLine =
  | {
      kind: "event";
      key: string;
      at: string;
      level: WorkflowLogLevel;
      stageId: string | null;
      message: string;
      detail: string;
      rawDetail: string;
    }
  | {
      kind: "lifecycle";
      key: string;
      at: string;
      level: WorkflowLogLevel;
      stageId: string;
      phase: "started" | "finished";
      state: WorkflowStageState;
      title: string;
      errorMessage: string;
    };

// Details already stated by the message or by the stage column.
const redundantDetailKeys = new Set(["status", "node_id", "node_type", "workflow_code"]);
const detailLimit = 160;

function logLevel(level: string): WorkflowLogLevel {
  const normalized = level.trim().toLowerCase();
  if (normalized === "error") return "error";
  if (normalized === "warn" || normalized === "warning") return "warn";
  return "info";
}

/** Scalar fields of an event detail as `key=value` pairs; nested values stay in the raw detail. */
export function compactLogDetail(detailJson: string) {
  const trimmed = detailJson.trim();
  if (!trimmed || trimmed === "{}" || trimmed === "null") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.length > detailLimit ? `${trimmed.slice(0, detailLimit - 1)}…` : trimmed;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const pairs = Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
    if (redundantDetailKeys.has(key)) return [];
    if (typeof value === "string") return value ? [`${key}=${value}`] : [];
    if (typeof value === "number" || typeof value === "boolean") return [`${key}=${value}`];
    return [];
  });
  const text = pairs.join(" ");
  return text.length > detailLimit ? `${text.slice(0, detailLimit - 1)}…` : text;
}

function timeValue(value: string) {
  return parseWorkflowTimestamp(value)?.getTime() ?? Number.POSITIVE_INFINITY;
}

function recordedStatus(event: WorkflowEvent) {
  try {
    const detail = JSON.parse(event.detailJson) as unknown;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const status = (detail as Record<string, unknown>).status;
      if (typeof status === "string") return workflowStageState(status);
    }
  } catch {
    // Unstructured details carry no status.
  }
  return null;
}

/** Whether the node's events already report this transition, by event type or by recorded status. */
function recorded(events: WorkflowEvent[], nodeRunID: number, suffixes: string[], states: WorkflowStageState[]) {
  return events.some(
    (event) =>
      event.nodeRunId === nodeRunID &&
      (suffixes.some((suffix) => event.eventType.endsWith(suffix)) || states.includes(recordedStatus(event) ?? "idle")),
  );
}

// Same-second ordering within a stage: queued records, derived start, other events, derived finish,
// then run-level events that followed the stage.
const rank = { queued: 0, start: 1, event: 2, finish: 3, runLevel: 4 } as const;

/**
 * Chronological console for a run. Recorded events come first-hand; node start and finish lines
 * are derived from node timestamps only where the run did not record them, so sparse system
 * workflows still show every stage's progress.
 */
export function workflowRunLog(events: WorkflowEvent[], nodeRuns: WorkflowNodeRun[]): WorkflowLogLine[] {
  const stageByNodeRun = new Map(nodeRuns.map((node) => [node.id, node.nodeId || String(node.id)]));
  const positionByNodeRun = new Map(nodeRuns.map((node) => [node.id, node.position]));
  // Timestamps have second resolution, so lines within one second follow stage order; run-level
  // events keep the position of the event before them.
  const entries: Array<{ line: WorkflowLogLine; time: number; position: number; rank: number; id: number }> = [];
  let carriedPosition = 0;
  [...events]
    .sort((left, right) => left.id - right.id)
    .forEach((event) => {
      const position = event.nodeRunId === null ? undefined : positionByNodeRun.get(event.nodeRunId);
      if (position !== undefined) carriedPosition = position;
      entries.push({
        time: timeValue(event.createdAt),
        position: carriedPosition,
        rank:
          position === undefined
            ? carriedPosition === 0
              ? rank.queued
              : rank.runLevel
            : recordedStatus(event) === "queued"
              ? rank.queued
              : rank.event,
        id: event.id,
        line: {
          kind: "event",
          key: `event-${event.id}`,
          at: event.createdAt,
          level: logLevel(event.level),
          stageId: event.nodeRunId === null ? null : (stageByNodeRun.get(event.nodeRunId) ?? null),
          message: event.message || event.eventType,
          detail: compactLogDetail(event.detailJson),
          rawDetail: event.detailJson,
        },
      });
    });
  nodeRuns.forEach((node) => {
    const stageId = node.nodeId || String(node.id);
    const title = node.displayName || node.nodeId;
    const state = workflowStageState(node.status);
    if (node.startedAt && !recorded(events, node.id, ["node_started", ".started"], ["running"])) {
      entries.push({
        time: timeValue(node.startedAt),
        position: node.position,
        rank: rank.start,
        id: node.id,
        line: {
          kind: "lifecycle",
          key: `start-${node.id}`,
          at: node.startedAt,
          level: "info",
          stageId,
          phase: "started",
          state: "running",
          title,
          errorMessage: "",
        },
      });
    }
    const settled = state === "succeeded" || state === "partial" || state === "failed" || state === "skipped";
    if (
      settled &&
      node.finishedAt &&
      !recorded(events, node.id, ["node_completed", "node_failed", ".completed", ".failed"], [state])
    ) {
      entries.push({
        time: timeValue(node.finishedAt),
        position: node.position,
        rank: rank.finish,
        id: node.id,
        line: {
          kind: "lifecycle",
          key: `finish-${node.id}`,
          at: node.finishedAt,
          level: state === "failed" ? "error" : state === "partial" ? "warn" : "info",
          stageId,
          phase: "finished",
          state,
          title,
          errorMessage: node.errorMessage,
        },
      });
    }
  });
  return entries
    .sort(
      (left, right) =>
        left.time - right.time || left.position - right.position || left.rank - right.rank || left.id - right.id,
    )
    .map((entry) => entry.line);
}

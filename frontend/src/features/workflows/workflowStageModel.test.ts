import { describe, expect, it } from "vitest";

import type { WorkflowEvent, WorkflowNodeRun } from "@/lib/api";

import { compactLogDetail, workflowRunLog, workflowStages } from "./workflowStageModel";

const definition = [
  { id: "select", type: "select_works", displayName: "Select works" },
  { id: "sync", type: "sync_metadata", displayName: "Sync metadata" },
  { id: "tag", type: "assign_user_tags" },
];

function nodeRun(overrides: Partial<WorkflowNodeRun>): WorkflowNodeRun {
  return {
    id: 1,
    nodeId: "select",
    nodeType: "select_works",
    displayName: "",
    position: 1,
    status: "queued",
    inputJson: "{}",
    outputJson: "{}",
    errorMessage: "",
    startedAt: "",
    finishedAt: "",
    createdAt: "2026-01-01 00:00:00",
    ...overrides,
  };
}

function event(overrides: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    id: 1,
    runId: 1,
    nodeRunId: null,
    jobId: null,
    level: "info",
    eventType: "run.recorded",
    message: "",
    detailJson: "{}",
    createdAt: "2026-01-01 00:00:00",
    ...overrides,
  };
}

describe("workflow stages", () => {
  it("keeps definition stages idle until a run reports them", () => {
    const stages = workflowStages(definition);
    expect(stages.map((stage) => [stage.id, stage.title, stage.state])).toEqual([
      ["select", "Select works", "idle"],
      ["sync", "Sync metadata", "idle"],
      ["tag", "tag", "idle"],
    ]);
  });

  it("projects the latest attempt of each node onto its definition stage", () => {
    const stages = workflowStages(definition, [
      nodeRun({ id: 1, nodeId: "select", position: 1, status: "succeeded" }),
      nodeRun({ id: 2, nodeId: "sync", position: 2, status: "failed", errorMessage: "timeout" }),
      nodeRun({ id: 3, nodeId: "sync", position: 2, status: "RUNNING", startedAt: "2026-01-01 00:00:05" }),
      nodeRun({ id: 4, nodeId: "unknown", position: 3, status: "succeeded" }),
    ]);
    expect(stages.map((stage) => stage.state)).toEqual(["succeeded", "running", "idle"]);
    expect(stages[1]).toMatchObject({ errorMessage: "", startedAt: "2026-01-01 00:00:05" });
  });

  it("falls back to recorded node runs when the definition has no stages", () => {
    const stages = workflowStages(
      [],
      [
        nodeRun({ id: 8, nodeId: "check", nodeType: "check_source", position: 2, status: "running" }),
        nodeRun({ id: 7, nodeId: "targets", displayName: "Snapshot pool", position: 1, status: "succeeded" }),
      ],
    );
    expect(stages.map((stage) => [stage.id, stage.title, stage.state])).toEqual([
      ["targets", "Snapshot pool", "succeeded"],
      ["check", "check", "running"],
    ]);
  });
});

describe("workflow run log", () => {
  it("orders recorded events chronologically and attributes them to stages", () => {
    const nodes = [nodeRun({ id: 10, nodeId: "select" }), nodeRun({ id: 11, nodeId: "sync", position: 2 })];
    const lines = workflowRunLog(
      [
        event({ id: 3, nodeRunId: 11, level: "WARNING", message: "Provider slow", createdAt: "2026-01-01 00:00:09" }),
        event({ id: 1, message: "Run queued", createdAt: "2026-01-01 00:00:00" }),
        event({ id: 2, nodeRunId: 10, eventType: "custom_workflow.node_started", createdAt: "2026-01-01 00:00:01" }),
      ],
      nodes,
    );
    expect(lines.map((line) => [line.key, line.stageId, line.level])).toEqual([
      ["event-1", null, "info"],
      ["event-2", "select", "info"],
      ["event-3", "sync", "warn"],
    ]);
    expect(lines[1]).toMatchObject({ message: "custom_workflow.node_started" });
  });

  it("derives stage start and finish lines only where the run recorded none", () => {
    const lines = workflowRunLog(
      [event({ id: 1, nodeRunId: 10, eventType: "custom_workflow.node_started", createdAt: "2026-01-01 00:00:01" })],
      [
        nodeRun({
          id: 10,
          nodeId: "select",
          status: "succeeded",
          startedAt: "2026-01-01 00:00:01",
          finishedAt: "2026-01-01 00:00:02",
        }),
        nodeRun({
          id: 11,
          nodeId: "sync",
          position: 2,
          status: "failed",
          errorMessage: "timeout",
          startedAt: "2026-01-01 00:00:02",
          finishedAt: "2026-01-01 00:00:08",
        }),
        nodeRun({ id: 12, nodeId: "tag", position: 3, status: "queued" }),
      ],
    );
    expect(lines.map((line) => line.key)).toEqual(["event-1", "finish-10", "start-11", "finish-11"]);
    expect(lines[3]).toMatchObject({ kind: "lifecycle", state: "failed", level: "error", errorMessage: "timeout" });
  });

  it("keeps same-second lines in stage order around recorded events", () => {
    const at = "2026-01-01 00:00:05";
    const lines = workflowRunLog(
      [
        event({ id: 1, message: "Run queued", createdAt: "2026-01-01 00:00:00" }),
        event({ id: 2, nodeRunId: 12, eventType: "scan.completed", createdAt: at }),
        event({ id: 3, eventType: "run.finished", createdAt: at }),
      ],
      [
        nodeRun({ id: 10, nodeId: "select", status: "succeeded", startedAt: "2026-01-01 00:00:00", finishedAt: at }),
        nodeRun({ id: 11, nodeId: "sync", position: 2, status: "succeeded", startedAt: at, finishedAt: at }),
        nodeRun({ id: 12, nodeId: "tag", position: 3, status: "succeeded", startedAt: at, finishedAt: at }),
      ],
    );
    expect(lines.map((line) => line.key)).toEqual([
      "event-1",
      "start-10",
      "finish-10",
      "start-11",
      "finish-11",
      "start-12",
      "event-2",
      "event-3",
    ]);
  });

  it("treats recorded node statuses as first-hand start and finish lines", () => {
    const at = "2026-01-01 00:00:01";
    const lines = workflowRunLog(
      [
        event({
          id: 1,
          nodeRunId: 10,
          eventType: "node.recorded",
          detailJson: '{"status":"succeeded"}',
          createdAt: at,
        }),
        event({ id: 2, nodeRunId: 11, eventType: "node.recorded", detailJson: '{"status":"queued"}', createdAt: at }),
      ],
      [
        nodeRun({ id: 10, nodeId: "select", status: "succeeded", startedAt: at, finishedAt: at }),
        nodeRun({ id: 11, nodeId: "sync", position: 2, status: "running", startedAt: at }),
      ],
    );
    expect(lines.map((line) => line.key)).toEqual(["start-10", "event-1", "event-2", "start-11"]);
  });

  it("summarizes scalar detail fields without restating the status", () => {
    expect(compactLogDetail('{"status":"succeeded","skipped_works":60,"failures":[],"tag":"daily"}')).toBe(
      "skipped_works=60 tag=daily",
    );
    expect(compactLogDetail("{}")).toBe("");
    expect(compactLogDetail("not json")).toBe("not json");
  });
});

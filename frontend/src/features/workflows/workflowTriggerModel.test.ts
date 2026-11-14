import { describe, expect, it } from "vitest";

import type { WorkflowTrigger } from "@/lib/api";

import {
  workflowSystemTriggerConfig,
  workflowSystemTriggerConfigBlockers,
  workflowSystemTriggerConfigPayload,
  workflowTriggerSummary,
} from "./workflowTriggerModel";

function trigger(configJson: string): WorkflowTrigger {
  return {
    id: 1,
    workflowDefinitionId: 1,
    workflowCode: "source_presence_check",
    displayName: "Check works",
    triggerType: "schedule",
    enabled: true,
    scheduleJson: '{"intervalMinutes":60}',
    configJson,
    nextRunAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorMessage: "",
    createdAt: "",
    updatedAt: "",
  };
}

describe("source presence trigger config", () => {
  it("round-trips the stored run options", () => {
    const stored = { sourceId: 2, library: "all", filter: "no_remote_source", limit: 500 };
    const config = workflowSystemTriggerConfig("source_presence_check", trigger(JSON.stringify(stored)));
    expect(workflowSystemTriggerConfigPayload("source_presence_check", "schedule", config)).toEqual(stored);
    expect(workflowSystemTriggerConfigBlockers("source_presence_check", config)).toEqual([]);
  });

  it("defaults to local works without a remote source and the default limit", () => {
    const config = workflowSystemTriggerConfig("source_presence_check", null);
    expect(workflowSystemTriggerConfigPayload("source_presence_check", "startup", { ...config, sourceId: 1 })).toEqual({
      sourceId: 1,
      library: "local",
      filter: "no_remote_source",
      limit: 100,
    });
  });

  it("blocks a trigger without a source or beyond the work limit", () => {
    const config = workflowSystemTriggerConfig("source_presence_check", null);
    expect(workflowSystemTriggerConfigBlockers("source_presence_check", config)).toHaveLength(1);
    expect(
      workflowSystemTriggerConfigBlockers("source_presence_check", { ...config, sourceId: 1, limit: 1001 }),
    ).toHaveLength(1);
  });
});

describe("workflowTriggerSummary", () => {
  const scheduled = (minutes: number, nextRunAt: string | null, enabled = true): WorkflowTrigger => ({
    ...trigger("{}"),
    scheduleJson: JSON.stringify({ intervalMinutes: minutes }),
    nextRunAt,
    enabled,
  });

  it("names what starts an operation on its own and when it next runs", () => {
    expect(
      workflowTriggerSummary([
        { ...trigger("{}"), triggerType: "startup" },
        { ...trigger("{}"), triggerType: "filesystem_event", enabled: false },
        scheduled(1440, "2026-07-15T00:00:00Z"),
        scheduled(360, "2026-07-14T06:00:00Z"),
        scheduled(90, null, false),
      ]),
    ).toEqual({
      startup: true,
      watching: false,
      intervals: [
        { unit: "hours", count: 6 },
        { unit: "days", count: 1 },
      ],
      nextRunAt: "2026-07-14T06:00:00Z",
      paused: false,
    });
  });

  it("tells a manual-only operation from one whose triggers are all off", () => {
    expect(workflowTriggerSummary([])).toBeNull();
    expect(workflowTriggerSummary([scheduled(45, null, false)])).toMatchObject({ paused: true, intervals: [] });
  });
});

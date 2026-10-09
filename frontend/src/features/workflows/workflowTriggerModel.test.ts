import { describe, expect, it } from "vitest";

import type { WorkflowTrigger } from "@/lib/api";

import {
  workflowSystemTriggerConfig,
  workflowSystemTriggerConfigBlockers,
  workflowSystemTriggerConfigPayload,
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

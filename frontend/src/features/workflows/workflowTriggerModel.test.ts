import { describe, expect, it } from "vitest";

import type { WorkflowTrigger } from "@/lib/api";

import {
  nextTriggerOrder,
  operationTriggerConfig,
  operationTriggerKinds,
  operationTriggerSlots,
  triggerIntervalChoices,
  triggerOffersFull,
  triggerRunsFull,
  triggerRunsOnItsOwn,
  triggerScheduleJson,
  triggerTakesMetadataOptions,
  workflowTriggerCondition,
  workflowTriggerSummary,
} from "./workflowTriggerModel";

function trigger(configJson: string): WorkflowTrigger {
  return {
    id: 1,
    workflowDefinitionId: 1,
    workflowCode: "metadata_sync",
    displayName: "Sync work metadata",
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

describe("workflowTriggerSummary", () => {
  const scheduled = (minutes: number, nextRunAt: string | null, enabled = true): WorkflowTrigger => ({
    ...trigger("{}"),
    scheduleJson: JSON.stringify({ intervalMinutes: minutes }),
    nextRunAt,
    enabled,
  });

  it("names what starts an operation on its own and states the server's next run", () => {
    expect(
      workflowTriggerSummary(
        [
          { ...trigger("{}"), triggerType: "startup" },
          { ...trigger("{}"), triggerType: "after_workflow", scheduleJson: '{"after":"local_library_scan"}' },
          { ...trigger("{}"), triggerType: "filesystem_event", enabled: false },
          scheduled(1440, "2026-07-15T00:00:00Z"),
          scheduled(360, "2026-07-14T06:00:00Z"),
          scheduled(90, null, false),
        ],
        "2026-07-14T06:00:00Z",
      ),
    ).toEqual({
      startup: true,
      after: "metadata_sync",
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
    expect(workflowTriggerSummary([], null)).toBeNull();
    expect(workflowTriggerSummary([scheduled(45, null, false)], null)).toMatchObject({
      paused: true,
      intervals: [],
    });
  });
});

describe("nextTriggerOrder", () => {
  it("lists schedules by their next run, then startup and folder triggers, and paused ones last", () => {
    const at = (id: number, triggerType: string, nextRunAt: string | null, enabled = true): WorkflowTrigger => ({
      ...trigger("{}"),
      id,
      triggerType,
      nextRunAt,
      enabled,
    });
    const ordered = nextTriggerOrder([
      at(1, "schedule", "2026-07-15T00:00:00Z", false),
      at(2, "filesystem_event", null),
      at(3, "startup", null),
      at(4, "schedule", null),
      at(5, "schedule", "2026-07-15T00:00:00Z"),
      at(6, "schedule", "2026-07-14T06:00:00Z"),
    ]);
    expect(ordered.map((item) => item.id)).toEqual([6, 5, 4, 3, 2, 1]);
  });
});

describe("triggerRunsOnItsOwn", () => {
  // A ranking pull's dispatcher is stored on with no interval; its lists plan its next run.
  const dispatcher = (nextRunAt: string | null): WorkflowTrigger => ({
    ...trigger("{}"),
    workflowCode: "dlsite_popular_collection",
    scheduleJson: "{}",
    nextRunAt,
  });

  it("counts a trigger the server plans only while it has a next run", () => {
    expect(triggerRunsOnItsOwn(dispatcher(null))).toBe(false);
    expect(triggerRunsOnItsOwn(dispatcher("2027-01-02T15:00:00Z"))).toBe(true);
    expect(workflowTriggerCondition(dispatcher("2027-01-02T15:00:00Z"))).toBeNull();
  });

  it("counts any other trigger while it is on, even before its next run is worked out", () => {
    expect(triggerRunsOnItsOwn(trigger("{}"))).toBe(true);
    expect(triggerRunsOnItsOwn({ ...trigger("{}"), enabled: false })).toBe(false);
    expect(triggerRunsOnItsOwn({ ...trigger("{}"), triggerType: "startup", scheduleJson: '{"type":"startup"}' })).toBe(
      true,
    );
  });
});

describe("operation trigger config", () => {
  it("runs the scans at startup and the operations that work on what a scan found after it", () => {
    expect(operationTriggerKinds("local_library_scan")).toEqual(["startup", "filesystem_event", "schedule"]);
    expect(operationTriggerKinds("record_library_scan")).toEqual(["startup", "schedule"]);
    for (const code of ["metadata_sync", "local_media_index", "record_media_probe"])
      expect(operationTriggerKinds(code)).toEqual(["after_workflow", "schedule"]);
    expect(triggerScheduleJson("record_media_probe", "after_workflow", 60)).toBe('{"after":"record_library_scan"}');
    expect(triggerScheduleJson("metadata_sync", "after_workflow", 60)).toBe('{"after":"local_library_scan"}');
    expect(triggerScheduleJson("record_library_scan", "startup", 60)).toBe('{"type":"startup"}');
  });

  it("works only on what the scan found new after a scan", () => {
    expect(triggerOffersFull("local_media_index", "after_workflow")).toBe(false);
    expect(triggerOffersFull("metadata_sync", "after_workflow")).toBe(false);
    expect(triggerOffersFull("record_media_probe", "schedule")).toBe(false);
    expect(operationTriggerConfig("local_media_index", "after_workflow", false)).toEqual({ mode: "incremental" });
    expect(operationTriggerConfig("record_media_probe", "after_workflow", false)).toEqual({});
  });

  it("stores the mode Full chooses for file indexing and metadata sync", () => {
    expect(operationTriggerConfig("local_media_index", "schedule", true)).toEqual({ mode: "full" });
    expect(operationTriggerConfig("metadata_sync", "schedule", false)).toMatchObject({ scope: "all", mode: "missing" });
    expect(triggerRunsFull("local_media_index", { triggerType: "startup", configJson: '{"mode":"full"}' })).toBe(true);
  });

  it("keeps the options an edited trigger stores that the dialog does not show", () => {
    const stored = JSON.stringify({ scope: "circle", circleId: "RG00000001", mode: "missing" });
    expect(operationTriggerConfig("metadata_sync", "schedule", true, stored)).toEqual({
      scope: "circle",
      circleId: "RG00000001",
      mode: "full",
    });
    expect(operationTriggerConfig("local_library_scan", "startup", false, '{"scanMode":"full"}')).toEqual({});
  });

  it("replaces a Metadata trigger's fallback and bonus options only when given", () => {
    const stored = JSON.stringify({
      scope: "all",
      mode: "missing",
      remoteMetadataFallback: { enabled: true, sourceIds: [2] },
      purchaseBonusAutoLink: true,
    });
    expect(operationTriggerConfig("metadata_sync", "after_workflow", false, stored)).toEqual(JSON.parse(stored));
    expect(
      operationTriggerConfig("metadata_sync", "after_workflow", false, stored, {
        remoteMetadataFallback: { enabled: true, sourceIds: [] },
        purchaseBonusAutoLink: false,
      }),
    ).toEqual({
      scope: "all",
      mode: "missing",
      remoteMetadataFallback: { enabled: false, sourceIds: [] },
      purchaseBonusAutoLink: false,
    });
    // A trigger that reads one named source asks no fallback, so it has no options to show.
    expect(triggerTakesMetadataOptions("metadata_sync", stored)).toBe(true);
    expect(triggerTakesMetadataOptions("metadata_sync", '{"scope":"voice","personId":3,"sourceId":4}')).toBe(false);
    expect(triggerTakesMetadataOptions("local_media_index", "{}")).toBe(false);
  });

  it("switches one trigger of each kind, the enabled one first, and lists the rest apart", () => {
    const at = (id: number, triggerType: string, enabled: boolean): WorkflowTrigger => ({
      ...trigger("{}"),
      id,
      triggerType,
      enabled,
    });
    const { slots, others } = operationTriggerSlots("local_media_index", [
      at(5, "schedule", false),
      at(6, "schedule", true),
      at(7, "after_workflow", false),
      at(8, "startup", true),
    ]);
    expect([...slots].map(([kind, item]) => [kind, item.id])).toEqual([
      ["schedule", 6],
      ["after_workflow", 7],
    ]);
    // A second schedule, and a kind Index does not take, stay listed apart.
    expect(others.map((item) => item.id)).toEqual([5, 8]);
  });

  it("scans in full only when watching folders asks for it", () => {
    expect(operationTriggerConfig("local_library_scan", "filesystem_event", true, "{}")).toEqual({ scanMode: "full" });
    expect(triggerRunsFull("local_library_scan", { triggerType: "schedule", configJson: '{"scanMode":"full"}' })).toBe(
      false,
    );
  });

  it("offers the usual intervals and keeps a stored one", () => {
    expect(triggerIntervalChoices(90)).toEqual([60, 90, 360, 720, 1440, 10080]);
  });
});

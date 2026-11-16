import { describe, expect, it } from "vitest";

import type { WorkflowTrigger } from "@/lib/api";

import {
  sourceCheckConfigJson,
  sourceCheckInterval,
  sourceCheckIntervalChoices,
  sourceCheckOptions,
  sourceCheckTriggers,
} from "./sourcePresenceCheckModel";

function trigger(overrides: Partial<WorkflowTrigger>): WorkflowTrigger {
  return {
    id: 1,
    workflowDefinitionId: 21,
    workflowCode: "source_presence_check",
    displayName: "Check works on a source",
    triggerType: "schedule",
    enabled: true,
    scheduleJson: '{"intervalMinutes":360}',
    configJson: '{"sourceId":8}',
    nextRunAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorMessage: "",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("source presence checks in source settings", () => {
  it("takes only this source's automatic checks, by kind", () => {
    const own = sourceCheckTriggers(
      [
        trigger({ id: 1 }),
        trigger({ id: 2, triggerType: "startup" }),
        trigger({ id: 3, configJson: '{"sourceId":9}' }),
        trigger({ id: 4, workflowCode: "metadata_sync" }),
      ],
      8,
    );
    expect(own.schedule.map((item) => item.id)).toEqual([1]);
    expect(own.startup.map((item) => item.id)).toEqual([2]);
  });

  it("shares the options an automatic check stores, and falls back to the defaults", () => {
    expect(sourceCheckOptions({ startup: [], schedule: [] }, 8)).toEqual({
      sourceId: 8,
      library: "local",
      filter: "no_remote_source",
      limit: 100,
    });
    const stored = trigger({ configJson: '{"sourceId":8,"library":"all","filter":"all","limit":250}' });
    expect(sourceCheckOptions({ startup: [], schedule: [stored] }, 8)).toEqual({
      sourceId: 8,
      library: "all",
      filter: "all",
      limit: 250,
    });
    expect(JSON.parse(sourceCheckConfigJson({ sourceId: 8, library: "all", filter: "all", limit: 250 }))).toEqual({
      sourceId: 8,
      library: "all",
      filter: "all",
      limit: 250,
    });
  });

  it("keeps a stored interval the list does not offer", () => {
    expect(sourceCheckInterval([])).toBe(1440);
    expect(sourceCheckInterval([trigger({ scheduleJson: '{"intervalMinutes":90}' })])).toBe(90);
    expect(sourceCheckIntervalChoices(90)).toEqual([60, 90, 360, 720, 1440, 10080]);
    expect(sourceCheckIntervalChoices(360)).toEqual([60, 360, 720, 1440, 10080]);
  });
});

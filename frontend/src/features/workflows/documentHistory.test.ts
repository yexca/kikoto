import { describe, expect, it } from "vitest";

import { createEmptyWorkflowDefinition } from "./definitionModel";
import { createWorkflowDocumentHistory, workflowDocumentHistoryReducer } from "./documentHistory";

describe("workflow document history", () => {
  it("coalesces continuous inspector edits and clears redo after divergence", () => {
    const initial = createEmptyWorkflowDefinition();
    let state = createWorkflowDocumentHistory(initial);
    state = workflowDocumentHistoryReducer(state, { type: "change", changedAt: 100, group: "name", update: { ...state.present, command: { enabled: true, alias: "a" } } });
    state = workflowDocumentHistoryReducer(state, { type: "change", changedAt: 200, group: "name", update: { ...state.present, command: { enabled: true, alias: "ab" } } });
    expect(state.past).toHaveLength(1);

    state = workflowDocumentHistoryReducer(state, { type: "undo" });
    expect(state.present).toBe(initial);
    expect(state.future).toHaveLength(1);

    state = workflowDocumentHistoryReducer(state, { type: "change", changedAt: 1000, update: { ...state.present, policy: { requirePreview: false } } });
    expect(state.future).toHaveLength(0);
  });

  it("replaces server defaults without adding an undo entry", () => {
    const initial = createEmptyWorkflowDefinition();
    const state = workflowDocumentHistoryReducer(createWorkflowDocumentHistory(initial), {
      type: "replace",
      update: { ...initial, policy: { requirePreview: false } },
    });
    expect(state.past).toHaveLength(0);
  });
});

import type { WorkflowDefinitionDocument } from "./definitionModel";

export type WorkflowDocumentHistory = {
  past: WorkflowDefinitionDocument[];
  present: WorkflowDefinitionDocument;
  future: WorkflowDefinitionDocument[];
  lastGroup: string;
  lastChangedAt: number;
};

export type WorkflowDocumentHistoryAction =
  | { type: "change"; update: WorkflowDefinitionDocument | ((current: WorkflowDefinitionDocument) => WorkflowDefinitionDocument); group?: string; changedAt?: number }
  | { type: "replace"; update: WorkflowDefinitionDocument | ((current: WorkflowDefinitionDocument) => WorkflowDefinitionDocument) }
  | { type: "undo" }
  | { type: "redo" };

const coalesceWindowMs = 750;

export function createWorkflowDocumentHistory(document: WorkflowDefinitionDocument): WorkflowDocumentHistory {
  return { past: [], present: document, future: [], lastGroup: "", lastChangedAt: 0 };
}

export function workflowDocumentHistoryReducer(state: WorkflowDocumentHistory, action: WorkflowDocumentHistoryAction): WorkflowDocumentHistory {
  if (action.type === "undo") {
    const previous = state.past[state.past.length - 1];
    if (!previous) return state;
    return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], lastGroup: "", lastChangedAt: 0 };
  }
  if (action.type === "redo") {
    const next = state.future[0];
    if (!next) return state;
    return { past: [...state.past, state.present], present: next, future: state.future.slice(1), lastGroup: "", lastChangedAt: 0 };
  }
  const next = typeof action.update === "function" ? action.update(state.present) : action.update;
  if (next === state.present) return state;
  if (action.type === "replace") return { ...state, present: next };
  const changedAt = action.changedAt ?? Date.now();
  const group = action.group ?? "";
  const coalesced = group !== "" && group === state.lastGroup && changedAt - state.lastChangedAt <= coalesceWindowMs;
  return {
    past: coalesced ? state.past : [...state.past, state.present],
    present: next,
    future: [],
    lastGroup: group,
    lastChangedAt: changedAt,
  };
}

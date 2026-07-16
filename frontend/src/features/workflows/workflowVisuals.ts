export type WorkflowEdgeVisualState = "idle" | "active" | "completed" | "failed" | "skipped";

const workflowDataTypeColors: Record<string, string> = {
  text: "#eab308",
  circle_id: "#0ea5e9",
  series_id: "#0ea5e9",
  voice_name: "#0ea5e9",
  work_code: "#0ea5e9",
  work_candidates: "#8b5cf6",
  work_refs: "#10b981",
  media_files: "#f59e0b",
  file_refs: "#f59e0b",
  error: "#ef4444",
  dynamic: "#64748b",
};

export function workflowDataTypeColor(type: string | null | undefined) {
  return workflowDataTypeColors[String(type ?? "").trim().toLowerCase()] ?? "#64748b";
}

export function workflowEdgeClassName(state: WorkflowEdgeVisualState) {
  return `workflow-data-edge workflow-data-edge--${state}`;
}

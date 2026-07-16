import { describe, expect, it } from "vitest";

import { workflowDataTypeColor, workflowEdgeClassName } from "./workflowVisuals";

describe("workflow visuals", () => {
  it("uses stable colors for typed workflow data", () => {
    expect(workflowDataTypeColor("circle_id")).toBe("#0ea5e9");
    expect(workflowDataTypeColor("work_candidates")).toBe("#8b5cf6");
    expect(workflowDataTypeColor("work_refs")).toBe("#10b981");
    expect(workflowDataTypeColor("text")).toBe("#eab308");
    expect(workflowDataTypeColor("unknown")).toBe("#64748b");
  });

  it("exposes execution state classes for shared edges", () => {
    expect(workflowEdgeClassName("active")).toBe("workflow-data-edge workflow-data-edge--active");
    expect(workflowEdgeClassName("failed")).toBe("workflow-data-edge workflow-data-edge--failed");
  });
});

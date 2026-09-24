import { describe, expect, it } from "vitest";

import { readWorkflowRunPrefill, workflowRunFormPath } from "./workflowLinks";

describe("workflow run-form links", () => {
  it("carries a creator target to the named workflow only", () => {
    const path = workflowRunFormPath("circle_follow", { circleId: " RG12345 ", personId: "" });
    expect(path).toBe("/workflows?workflow=circle_follow&circleId=RG12345");
    const search = path.slice(path.indexOf("?"));
    expect(readWorkflowRunPrefill("circle_follow", search)).toEqual({ circleId: "RG12345" });
    // Another workflow's form must not pick up this target.
    expect(readWorkflowRunPrefill("voice_follow", search)).toEqual({});
  });
});

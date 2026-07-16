import { describe, expect, it } from "vitest";

import { createEmptyWorkflowDefinition, type WorkflowInputDefinition } from "./definitionModel";
import { parseWorkflowCommand, publishedWorkflowCommandsForUser, workflowCommandInputValues, workflowCommandUsage, workflowRunInputPayload } from "./workflowCommands";
import type { WorkflowDefinition } from "@/lib/api";

const circleInput: WorkflowInputDefinition = {
  key: "circle",
  label: "Circle",
  type: "circle_id",
  required: true,
};

describe("workflow Quick Action commands", () => {
  it("publishes aliases only from definitions owned by the current user", () => {
    const document = createEmptyWorkflowDefinition();
    document.command = { enabled: true, alias: "sharedAlias" };
    const definition = (id: number, ownerUserId: number | null, scope: WorkflowDefinition["scope"] = "user"): WorkflowDefinition => ({
      id,
      code: `workflow_${id}`,
      displayName: `Workflow ${id}`,
      description: "",
      definitionJson: JSON.stringify(document),
      scope,
      editable: scope === "user",
      ownerUserId,
      triggerCount: 0,
      createdAt: "2026-07-16T00:00:00Z",
      updatedAt: "2026-07-16T00:00:00Z",
    });

    const commands = publishedWorkflowCommandsForUser([
      definition(1, 7),
      definition(2, 8),
      definition(3, null),
      definition(4, null, "system"),
    ], 7);

    expect(commands.map((command) => command.definition.id)).toEqual([1]);
    expect(publishedWorkflowCommandsForUser([definition(1, 7)], null)).toEqual([]);
  });

  it("omits blank optional inputs from preview and confirm payloads", () => {
    const inputs: WorkflowInputDefinition[] = [
      { key: "text", label: "Text", type: "text", required: true },
      { key: "circle", label: "Circle", type: "circle_id", required: false },
      { key: "work", label: "Work", type: "work_code", required: false },
    ];

    expect(workflowRunInputPayload(inputs, { text: "literal", circle: "  ", work: "" })).toEqual({ text: "literal" });
    expect(workflowRunInputPayload(inputs, { text: "literal", circle: "RG01234" })).toEqual({ text: "literal", circle: "RG01234" });
  });

  it("distinguishes normal search text from slash commands", () => {
    expect(parseWorkflowCommand("RG01234")).toEqual({ isCommand: false, alias: "", arguments: [], error: "" });
    expect(parseWorkflowCommand("/getCircle RG01234")).toEqual({
      isCommand: true,
      alias: "getCircle",
      arguments: ["RG01234"],
      error: "",
    });
  });

  it("binds one positional value to one declared input", () => {
    expect(workflowCommandInputValues(["RG01234"], [circleInput])).toEqual({
      values: { circle: "RG01234" },
      errors: [],
    });
    expect(workflowCommandUsage("getCircle", [circleInput])).toBe("/getCircle <circle>");
  });

  it("keeps equals signs literal for one text input unless the declared key is used", () => {
    const textInput: WorkflowInputDefinition = { key: "text", label: "Text", type: "text", required: true };

    expect(workflowCommandInputValues(["foo=bar", "quality=lossless"], [textInput])).toEqual({
      values: { text: "foo=bar quality=lossless" },
      errors: [],
    });
    expect(workflowCommandInputValues(["text=foo=bar"], [textInput])).toEqual({
      values: { text: "foo=bar" },
      errors: [],
    });
  });

  it("supports quoted named values for workflows with multiple inputs", () => {
    const parsed = parseWorkflowCommand('/voiceWorks source=example voice="Example Voice"');
    const inputs: WorkflowInputDefinition[] = [
      { key: "source", label: "Source", type: "text", required: true },
      { key: "voice", label: "Voice", type: "voice_name", required: true },
    ];

    expect(parsed.arguments).toEqual(["source=example", "voice=Example Voice"]);
    expect(workflowCommandInputValues(parsed.arguments, inputs)).toEqual({
      values: { source: "example", voice: "Example Voice" },
      errors: [],
    });
  });

  it("reports malformed quoting, unknown keys, duplicate values, and missing required values", () => {
    expect(parseWorkflowCommand('/getCircle "RG01234').error).toBe("Close the quoted argument.");

    const optionalSource: WorkflowInputDefinition = { key: "source", label: "Source", type: "text", required: false };
    const result = workflowCommandInputValues(["unknown=value", "circle=RG01234", "circle=RG09999"], [circleInput, optionalSource]);
    expect(result.errors).toEqual([
      "Unknown input: unknown.",
      "Input circle was provided more than once.",
    ]);

    expect(workflowCommandInputValues([], [circleInput]).errors).toEqual(["Circle is required."]);
  });

  it("validates domain ids before starting a workflow", () => {
    const workInput: WorkflowInputDefinition = { key: "work", label: "Work", type: "work_code", required: true };

    expect(workflowCommandInputValues(["circle=RJ01234567"], [circleInput]).errors).toEqual([
      "Circle: use a DLsite circle id such as RG01234.",
    ]);
    expect(workflowCommandInputValues(["work=../../outside"], [workInput]).errors).toEqual([
      "Work: use a supported work code.",
    ]);
    expect(workflowCommandInputValues(["CC0001"], [workInput]).errors).toEqual([]);
    expect(workflowCommandInputValues(["BG01234"], [circleInput]).errors).toEqual([]);
    expect(workflowCommandInputValues(["VG12345678"], [circleInput]).errors).toEqual([]);
    expect(workflowCommandInputValues(["RG1234"], [circleInput]).errors).toEqual([
      "Circle: use a DLsite circle id such as RG01234.",
    ]);
  });

  it("keeps command arguments as literal data", () => {
    const input: WorkflowInputDefinition = { key: "tag", label: "Tag", type: "text", required: true };
    const parsed = parseWorkflowCommand('/tagWorks tag="$(Write-Output literal)"');

    expect(workflowCommandInputValues(parsed.arguments, [input])).toEqual({
      values: { tag: "$(Write-Output literal)" },
      errors: [],
    });
  });

  it("does not let an input key mutate the values object prototype", () => {
    const input: WorkflowInputDefinition = { key: "__proto__", label: "Unsafe", type: "text", required: true };
    const result = workflowCommandInputValues(["__proto__=literal"], [input]);

    expect(Object.prototype.hasOwnProperty.call(result.values, "__proto__")).toBe(true);
    expect(result.values.__proto__).toBe("literal");
    expect(({} as Record<string, unknown>).literal).toBeUndefined();
  });
});

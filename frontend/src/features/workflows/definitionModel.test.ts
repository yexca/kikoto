import { describe, expect, it } from "vitest";

import type { WorkflowNodeType } from "@/lib/api";

import {
  createEmptyWorkflowDefinition,
  parseWorkflowDefinition,
  serializeWorkflowDefinition,
  upgradeLegacyWorkflowDefinition,
  validateWorkflowDefinition,
  wouldCreateWorkflowCycle,
  workflowNodePorts,
  type WorkflowDefinitionDocument,
} from "./definitionModel";

const nodeTypes: WorkflowNodeType[] = [
  {
    type: "read_circle_catalog",
    phase: "discover",
    displayName: "Read circle catalog",
    description: "Read catalog candidates without materializing works.",
    userVisible: true,
    configSchema: "{}",
    inputSchema: "{}",
    outputSchema: "{}",
    inputPorts: [{ id: "circle", label: "Circle", type: "circle_id" }],
    outputPorts: [{ id: "candidates", label: "Candidates", type: "catalog_candidates" }],
  },
  {
    type: "filter_candidates",
    phase: "filter",
    displayName: "Filter candidates",
    description: "Filter candidate data.",
    userVisible: true,
    configSchema: "{}",
    inputSchema: "{}",
    outputSchema: "{}",
    inputPorts: [{ id: "candidates", label: "Candidates", type: "catalog_candidates" }],
    outputPorts: [{ id: "accepted", label: "Accepted", type: "catalog_candidates" }],
  },
];

function validDefinition(): WorkflowDefinitionDocument {
  return {
    ...createEmptyWorkflowDefinition(),
    command: { enabled: true, alias: "getCircle" },
    inputs: [{ key: "circle", label: "Circle", type: "circle_id", required: true }],
    nodes: [
      { id: "circle_input", type: "workflow_input", config: { inputKey: "circle" }, position: { x: 0, y: 40 } },
      { id: "catalog", type: "read_circle_catalog", position: { x: 240, y: 40 } },
      { id: "filter", type: "filter_candidates", position: { x: 480, y: 40 } },
    ],
    edges: [
      { id: "circle", source: "circle_input", sourceHandle: "value", target: "catalog", targetHandle: "circle" },
      { id: "catalog", source: "catalog", sourceHandle: "candidates", target: "filter", targetHandle: "candidates" },
    ],
  };
}

describe("workflow definition model", () => {
  it("exposes work-code inputs as candidate collections", () => {
    const document = createEmptyWorkflowDefinition();
    document.inputs = [{ key: "work", label: "Work", type: "work_code", required: true }];
    const node = {
      id: "work_input",
      type: "workflow_input",
      config: { inputKey: "work" },
      position: { x: 0, y: 0 },
    };
    document.nodes = [node];

    expect(workflowNodePorts(document, node, nodeTypes).outputs[0]?.type).toBe("work_candidates");
  });

  it("keeps legacy linear definitions readable", () => {
    const parsed = parseWorkflowDefinition(JSON.stringify({
      nodes: [
        { id: "select", type: "select_works", displayName: "Select works" },
        { id: "sync", type: "sync_metadata", config: { forceRefresh: false } },
      ],
    }));

    expect(parsed).toEqual({
      kind: "legacy",
      nodes: [
        { id: "select", type: "select_works", displayName: "Select works" },
        { id: "sync", type: "sync_metadata", config: { forceRefresh: false } },
      ],
    });
  });

  it("upgrades only lossless legacy metadata flows in memory", () => {
    const upgrade = upgradeLegacyWorkflowDefinition([
      { id: "select", type: "select_works", config: { codes: ["RJ01234567"] } },
      { id: "sync", type: "sync_metadata" },
    ], [{ triggerType: "schedule", scheduleJson: '{"intervalMinutes":60}', configJson: "{\"inputs\":{}}" }]);

    expect(upgrade.kind).toBe("upgradeable");
    if (upgrade.kind !== "upgradeable") return;
    expect(upgrade.document.policy.requirePreview).toBe(false);
    expect(upgrade.document.inputs[0]).toMatchObject({ type: "work_codes", defaultValue: "RJ01234567" });
    expect(upgrade.document.nodes.map((node) => node.type)).toEqual(["workflow_input", "metadata_sync"]);
  });

  it("blocks legacy upgrades with unsupported nodes or triggers", () => {
    const upgrade = upgradeLegacyWorkflowDefinition([
      { id: "scan", type: "discover_local_files" },
      { id: "sync", type: "sync_file_locations" },
    ], [{ triggerType: "filesystem_event", scheduleJson: "{}", configJson: "{}" }]);

    expect(upgrade.kind).toBe("blocked");
    if (upgrade.kind === "blocked") expect(upgrade.reasons.join(" ")).toContain("filesystem_event");
  });

  it("round-trips v2 inputs, positions, edges, command, and approval policy", () => {
    const definition = validDefinition();
    const parsed = parseWorkflowDefinition(serializeWorkflowDefinition(definition));

    expect(parsed).toEqual({ kind: "v2", document: definition });
  });

  it("accepts a typed acyclic graph with declared workflow inputs", () => {
    const issues = validateWorkflowDefinition(validDefinition(), nodeTypes);

    expect(issues.filter((issue) => issue.level === "error")).toEqual([]);
    expect(issues.filter((issue) => issue.level === "warning")).toEqual([]);
  });

  it("accepts configured entity values in place of required entity ports", () => {
    const entityNodeTypes: WorkflowNodeType[] = [
      { ...nodeTypes[0], type: "circle_catalog", inputPorts: [{ id: "circle", label: "Circle", type: "circle_id", required: true }] },
      { ...nodeTypes[0], type: "series_catalog", inputPorts: [{ id: "series", label: "Series", type: "series_id", required: true }] },
      { ...nodeTypes[0], type: "voice_source_works", inputPorts: [{ id: "voice", label: "Voice", type: "voice_name", required: true }] },
    ];
    const cases = [
      { type: "circle_catalog", config: { circleId: "RG01234" } },
      { type: "series_catalog", config: { seriesId: "SRI0001" } },
      { type: "voice_source_works", config: { voiceName: "Example Voice", sourceId: 1 } },
    ];

    for (const [index, item] of cases.entries()) {
      const definition = createEmptyWorkflowDefinition();
      definition.nodes = [{ id: `entity_${index}`, type: item.type, config: item.config, position: { x: 0, y: 0 } }];
      expect(validateWorkflowDefinition(definition, entityNodeTypes).filter((issue) => issue.level === "error")).toEqual([]);
    }
  });

  it("rejects type mismatches and dangling graph references", () => {
    const definition = validDefinition();
    definition.edges = [
      { id: "wrong_type", source: "circle_input", sourceHandle: "value", target: "filter", targetHandle: "candidates" },
      { id: "missing_node", source: "catalog", sourceHandle: "candidates", target: "removed", targetHandle: "candidates" },
    ];

    const messages = validateWorkflowDefinition(definition, nodeTypes).map((issue) => issue.message);

    expect(messages).toContain("circle_id cannot connect to catalog_candidates.");
    expect(messages).toContain("Edge references a missing node.");
  });

  it("detects a proposed cycle before adding the connection", () => {
    const nodes = [{ id: "first" }, { id: "second" }, { id: "third" }];
    const edges = [
      { source: "first", target: "second" },
      { source: "second", target: "third" },
    ];

    expect(wouldCreateWorkflowCycle(nodes, edges, { source: "third", target: "first" })).toBe(true);
    expect(wouldCreateWorkflowCycle(nodes, edges, { source: "first", target: "third" })).toBe(false);
  });

  it("does not accept arbitrary executable node types", () => {
    const definition = validDefinition();
    definition.nodes.push({
      id: "script",
      type: "javascript",
      config: { source: "readPrivateState()" },
      position: { x: 720, y: 40 },
    });

    expect(validateWorkflowDefinition(definition, nodeTypes)).toContainEqual({
      level: "error",
      message: "Unknown node type: javascript.",
      nodeId: "script",
    });
  });

  it("restricts workflow input keys to stable lowercase identifiers", () => {
    const definition = validDefinition();
    definition.inputs[0].key = "__proto__";
    definition.nodes[0].config = { inputKey: "__proto__" };

    expect(validateWorkflowDefinition(definition, nodeTypes).map((issue) => issue.message)).toContain(
      "Workflow input keys must be lowercase snake_case.",
    );
  });
});

import type { WorkflowNodeType, WorkflowNodeTypePort } from "@/lib/api";

export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 2 as const;

export type WorkflowInputType = "text" | "circle_id" | "series_id" | "voice_name" | "work_code";

export type WorkflowInputDefinition = {
  key: string;
  label: string;
  type: WorkflowInputType;
  required: boolean;
  defaultValue?: string;
};

export type WorkflowCommandDefinition = {
  enabled: boolean;
  alias: string;
};

export type WorkflowApprovalPolicy = {
  requirePreview: boolean;
};

export type WorkflowNodeDefinition = {
  id: string;
  type: string;
  displayName?: string;
  config?: Record<string, unknown>;
  position: { x: number; y: number };
};

export type WorkflowEdgeDefinition = {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
};

export type WorkflowDefinitionDocument = {
  schemaVersion: typeof WORKFLOW_DEFINITION_SCHEMA_VERSION;
  command: WorkflowCommandDefinition;
  inputs: WorkflowInputDefinition[];
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
  policy: WorkflowApprovalPolicy;
};

export type LegacyWorkflowNode = {
  id: string;
  type: string;
  displayName?: string;
  config?: Record<string, unknown>;
};

export type ParsedWorkflowDefinition =
  | { kind: "v2"; document: WorkflowDefinitionDocument }
  | { kind: "legacy"; nodes: LegacyWorkflowNode[] };

export type WorkflowDefinitionIssue = {
  level: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type WorkflowPort = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  multiple: boolean;
  nodeId: string;
};

const inputTypes: readonly WorkflowInputType[] = ["text", "circle_id", "series_id", "voice_name", "work_code"];
const commandAliasPattern = /^[A-Za-z][A-Za-z0-9_-]{1,31}$/;
const inputKeyPattern = /^[a-z][a-z0-9_]{0,31}$/;

export function createEmptyWorkflowDefinition(): WorkflowDefinitionDocument {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    command: { enabled: false, alias: "" },
    inputs: [],
    nodes: [],
    edges: [],
    policy: { requirePreview: true },
  };
}

export function parseWorkflowDefinition(definitionJson: string): ParsedWorkflowDefinition {
  let value: unknown;
  try {
    value = JSON.parse(definitionJson);
  } catch {
    return { kind: "legacy", nodes: [] };
  }
  if (!isRecord(value) || value.schemaVersion !== WORKFLOW_DEFINITION_SCHEMA_VERSION) {
    return { kind: "legacy", nodes: legacyNodes(value) };
  }

  const inputs = Array.isArray(value.inputs)
    ? value.inputs.map(normalizeInput).filter((input): input is WorkflowInputDefinition => input !== null)
    : [];
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.map(normalizeNode).filter((node): node is WorkflowNodeDefinition => node !== null)
    : [];
  const edges = Array.isArray(value.edges)
    ? value.edges.map(normalizeEdge).filter((edge): edge is WorkflowEdgeDefinition => edge !== null)
    : [];
  const rawCommand = isRecord(value.command) ? value.command : {};
  const rawPolicy = isRecord(value.policy) ? value.policy : {};

  return {
    kind: "v2",
    document: {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      command: {
        enabled: rawCommand.enabled === true,
        alias: stringValue(rawCommand.alias),
      },
      inputs,
      nodes,
      edges,
      policy: { requirePreview: rawPolicy.requirePreview !== false },
    },
  };
}

export function serializeWorkflowDefinition(document: WorkflowDefinitionDocument) {
  return JSON.stringify(document);
}

export function workflowDefinitionNodeCount(definitionJson: string) {
  const parsed = parseWorkflowDefinition(definitionJson);
  return parsed.kind === "v2" ? parsed.document.nodes.length : parsed.nodes.length;
}

export function workflowNodePorts(
  document: WorkflowDefinitionDocument,
  node: WorkflowNodeDefinition,
  nodeTypes: WorkflowNodeType[],
): { inputs: WorkflowPort[]; outputs: WorkflowPort[] } {
  if (node.type === "workflow_input") {
    const inputKey = stringValue(node.config?.inputKey);
    const input = document.inputs.find((candidate) => candidate.key === inputKey);
    return {
      inputs: [],
      outputs: [{ id: "value", label: input?.label || "Value", type: workflowInputPortType(input?.type), required: true, multiple: true, nodeId: node.id }],
    };
  }
  const metadata = nodeTypes.find((candidate) => candidate.type === node.type);
  return {
    inputs: normalizePorts(metadata?.inputPorts).map((port) => ({ ...port, nodeId: node.id })),
    outputs: normalizePorts(metadata?.outputPorts).map((port) => ({ ...port, nodeId: node.id })),
  };
}

export function canConnectWorkflowPorts(source: WorkflowPort | undefined, target: WorkflowPort | undefined) {
  if (!source || !target) return false;
  if (source.type === "any" || target.type === "any") return true;
  return source.type === target.type;
}

export function wouldCreateWorkflowCycle(
  nodes: Pick<WorkflowNodeDefinition, "id">[],
  edges: Pick<WorkflowEdgeDefinition, "source" | "target">[],
  connection: Pick<WorkflowEdgeDefinition, "source" | "target">,
) {
  if (connection.source === connection.target) return true;
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) outgoing.set(node.id, []);
  for (const edge of [...edges, connection]) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const pending = [connection.target];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || visited.has(nodeId)) continue;
    if (nodeId === connection.source) return true;
    visited.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }
  return false;
}

export function validateWorkflowDefinition(document: WorkflowDefinitionDocument, nodeTypes: WorkflowNodeType[]) {
  const issues: WorkflowDefinitionIssue[] = [];
  const nodeMap = new Map<string, WorkflowNodeDefinition>();
  const inputKeys = new Set<string>();

  if (document.nodes.length === 0) issues.push({ level: "error", message: "Add at least one node." });
  if (document.command.enabled && !commandAliasPattern.test(document.command.alias)) {
    issues.push({ level: "error", message: "Quick Action alias must be 2-32 letters, numbers, underscores, or hyphens." });
  }

  for (const input of document.inputs) {
    if (!inputKeyPattern.test(input.key)) issues.push({ level: "error", message: "Workflow input keys must be lowercase snake_case." });
    if (inputKeys.has(input.key)) issues.push({ level: "error", message: `Workflow input key "${input.key}" is duplicated.` });
    inputKeys.add(input.key);
  }

  for (const node of document.nodes) {
    if (!node.id.trim()) issues.push({ level: "error", message: "Node ids cannot be empty.", nodeId: node.id });
    if (nodeMap.has(node.id)) issues.push({ level: "error", message: `Node id "${node.id}" is duplicated.`, nodeId: node.id });
    nodeMap.set(node.id, node);
    if (node.type !== "workflow_input" && !nodeTypes.some((candidate) => candidate.type === node.type)) {
      issues.push({ level: "error", message: `Unknown node type: ${node.type}.`, nodeId: node.id });
    }
    if (node.type === "workflow_input") {
      const inputKey = stringValue(node.config?.inputKey);
      if (!inputKeys.has(inputKey)) {
        issues.push({ level: "error", message: "Input node must reference a workflow input.", nodeId: node.id });
      }
    }
    if (["voice_source_works", "check_source_availability"].includes(node.type) && !positiveNumber(node.config?.sourceId)) {
      issues.push({ level: "error", message: "Select a remote source.", nodeId: node.id });
    }
    if (!document.policy.requirePreview) {
      const requiredBounds = node.type === "circle_catalog" || node.type === "series_catalog"
        ? ["maxWorks"]
        : node.type === "voice_source_works"
          ? ["maxWorks", "maxPages"]
          : node.type === "track_works"
            ? ["maxWorks"]
            : node.type === "fetch_works"
              ? ["maxWorks", "maxFiles", "maxBytes"]
              : [];
      for (const key of requiredBounds) {
        if (!positiveNumber(node.config?.[key])) issues.push({ level: "error", message: `${key} is required for bounded direct launch.`, nodeId: node.id });
      }
      if (node.type === "fetch_works" && node.config?.allowUnknownSizes === true) {
        issues.push({ level: "error", message: "Unknown file sizes require preview confirmation.", nodeId: node.id });
      }
    }
  }

  const incoming = new Map<string, number>();
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (edgeIds.has(edge.id)) issues.push({ level: "error", message: `Edge id "${edge.id}" is duplicated.`, edgeId: edge.id });
    edgeIds.add(edge.id);
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    if (!sourceNode || !targetNode) {
      issues.push({ level: "error", message: "Edge references a missing node.", edgeId: edge.id });
      continue;
    }
    const source = workflowNodePorts(document, sourceNode, nodeTypes).outputs.find((port) => port.id === edge.sourceHandle);
    const target = workflowNodePorts(document, targetNode, nodeTypes).inputs.find((port) => port.id === edge.targetHandle);
    if (!source || !target) {
      issues.push({ level: "error", message: "Edge references a missing port.", edgeId: edge.id });
    } else if (!canConnectWorkflowPorts(source, target)) {
      issues.push({ level: "error", message: `${source.type} cannot connect to ${target.type}.`, edgeId: edge.id });
    }
    const incomingKey = `${edge.target}:${edge.targetHandle}`;
    incoming.set(incomingKey, (incoming.get(incomingKey) ?? 0) + 1);
    if ((incoming.get(incomingKey) ?? 0) > 1 && target?.multiple !== true) {
      issues.push({ level: "error", message: `${target?.label || target?.id || edge.targetHandle} accepts one connection.`, edgeId: edge.id });
    }
  }

  if (hasWorkflowCycle(document.nodes, document.edges)) {
    issues.push({ level: "error", message: "Workflow graph must not contain a cycle." });
  }

  for (const node of document.nodes) {
    for (const port of workflowNodePorts(document, node, nodeTypes).inputs) {
      if (port.required !== false && !incoming.has(`${node.id}:${port.id}`) && !nodeConfigSuppliesPort(node, port.id)) {
        issues.push({ level: "error", message: `${port.label || port.id} is not connected.`, nodeId: node.id });
      }
    }
  }
  return issues;
}

export function createWorkflowEdgeID(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return `${source}:${sourceHandle}->${target}:${targetHandle}`;
}

export function uniqueWorkflowNodeID(type: string, nodes: Pick<WorkflowNodeDefinition, "id">[]) {
  const base = type.replace(/[^a-z0-9_]/gi, "_").replace(/^_+|_+$/g, "") || "node";
  const used = new Set(nodes.map((node) => node.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function hasWorkflowCycle(nodes: Pick<WorkflowNodeDefinition, "id">[], edges: Pick<WorkflowEdgeDefinition, "source" | "target">[]) {
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.source) || !incoming.has(edge.target)) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) continue;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const count = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, count);
      if (count === 0) queue.push(target);
    }
  }
  return visited !== nodes.length;
}

function normalizePorts(ports: WorkflowNodeTypePort[] | undefined) {
  if (!Array.isArray(ports)) return [];
  return ports
    .map((port) => ({
      id: stringValue(port.id),
      label: stringValue(port.label) || stringValue(port.id),
      type: stringValue(port.type) || stringValue(port.dataType) || "any",
      required: port.required !== false,
      multiple: port.multiple === true,
    }))
    .filter((port) => port.id);
}

function normalizeInput(value: unknown): WorkflowInputDefinition | null {
  if (!isRecord(value)) return null;
  const key = stringValue(value.key);
  const rawType = stringValue(value.type);
  const type = inputTypes.includes(rawType as WorkflowInputType) ? rawType as WorkflowInputType : "text";
  if (!key) return null;
  const defaultValue = stringValue(value.defaultValue);
  return {
    key,
    label: stringValue(value.label) || key,
    type,
    required: value.required !== false,
    ...(defaultValue ? { defaultValue } : {}),
  };
}

function normalizeNode(value: unknown): WorkflowNodeDefinition | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const type = stringValue(value.type);
  if (!id || !type) return null;
  const rawPosition = isRecord(value.position) ? value.position : {};
  return {
    id,
    type,
    ...(stringValue(value.displayName) ? { displayName: stringValue(value.displayName) } : {}),
    ...(isRecord(value.config) ? { config: value.config } : {}),
    position: { x: finiteNumber(rawPosition.x), y: finiteNumber(rawPosition.y) },
  };
}

function normalizeEdge(value: unknown): WorkflowEdgeDefinition | null {
  if (!isRecord(value)) return null;
  const source = stringValue(value.source);
  const target = stringValue(value.target);
  const sourceHandle = stringValue(value.sourceHandle);
  const targetHandle = stringValue(value.targetHandle);
  if (!source || !target || !sourceHandle || !targetHandle) return null;
  return {
    id: stringValue(value.id) || createWorkflowEdgeID(source, sourceHandle, target, targetHandle),
    source,
    sourceHandle,
    target,
    targetHandle,
  };
}

function legacyNodes(value: unknown): LegacyWorkflowNode[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return [];
  return value.nodes.flatMap((node) => {
    if (!isRecord(node)) return [];
    const id = stringValue(node.id);
    const type = stringValue(node.type);
    if (!id || !type) return [];
    return [{
      id,
      type,
      ...(stringValue(node.displayName) ? { displayName: stringValue(node.displayName) } : {}),
      ...(isRecord(node.config) ? { config: node.config } : {}),
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nodeConfigSuppliesPort(node: WorkflowNodeDefinition, portId: string) {
  const configKey = node.type === "circle_catalog" && portId === "circle"
    ? "circleId"
    : node.type === "series_catalog" && portId === "series"
      ? "seriesId"
      : node.type === "voice_source_works" && portId === "voice"
        ? "voiceName"
        : "";
  return configKey !== "" && stringValue(node.config?.[configKey]).trim() !== "";
}

function workflowInputPortType(type: WorkflowInputType | undefined) {
  return type === "work_code" ? "work_candidates" : type || "text";
}

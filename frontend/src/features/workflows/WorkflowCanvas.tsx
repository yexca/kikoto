import {
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type OnNodeDrag,
  type NodeProps,
} from "@xyflow/react";
import { Braces, CircleDot, Download, Filter, GitBranch, Tags, Type, Workflow } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import {
  canConnectWorkflowPorts,
  createWorkflowEdgeID,
  type WorkflowDefinitionDocument,
  type WorkflowNodeDefinition,
  type WorkflowPort,
  workflowNodePorts,
  wouldCreateWorkflowCycle,
} from "@/features/workflows/definitionModel";
import type { WorkflowNodeType } from "@/lib/api";

type WorkflowCanvasNodeData = Record<string, unknown> & {
  definition: WorkflowNodeDefinition;
  metadata?: WorkflowNodeType;
  inputs: WorkflowPort[];
  outputs: WorkflowPort[];
};

type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, "workflowEditor">;

export function WorkflowCanvas({
  document,
  nodeTypes,
  selectedNodeId,
  readonly = false,
  compact = false,
  onChange,
  onSelectNode,
}: {
  document: WorkflowDefinitionDocument;
  nodeTypes: WorkflowNodeType[];
  selectedNodeId: string;
  readonly?: boolean;
  compact?: boolean;
  onChange: (document: WorkflowDefinitionDocument) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [connectionNotice, setConnectionNotice] = useState("");
  const [flowNodes, setFlowNodes] = useState<WorkflowCanvasNode[]>(() => reconcileFlowNodes([], document, nodeTypes, selectedNodeId));

  useEffect(() => {
    setFlowNodes((current) => reconcileFlowNodes(current, document, nodeTypes, selectedNodeId));
  }, [document.inputs, document.nodes, nodeTypes, selectedNodeId]);

  useEffect(() => {
    if (!connectionNotice) return;
    const timeout = window.setTimeout(() => setConnectionNotice(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [connectionNotice]);

  const flowEdges = useMemo<Edge[]>(() => document.edges.map((edge) => ({
    ...edge,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { strokeWidth: 1.6 },
    selected: edge.id === selectedEdgeId,
  })), [document.edges, selectedEdgeId]);

  const connectionIssue = useCallback((connection: Connection | Edge) => workflowConnectionIssue(document, nodeTypes, connection), [document, nodeTypes]);
  const isValidConnection = useCallback((connection: Connection | Edge) => connectionIssue(connection) === "", [connectionIssue]);

  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection) || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const edge = {
      id: createWorkflowEdgeID(connection.source, connection.sourceHandle, connection.target, connection.targetHandle),
      source: connection.source,
      sourceHandle: connection.sourceHandle,
      target: connection.target,
      targetHandle: connection.targetHandle,
    };
    setConnectionNotice("");
    onChange({ ...document, edges: [...document.edges.filter((candidate) => candidate.id !== edge.id), edge] });
  }, [document, isValidConnection, onChange]);

  const onNodesChange = useCallback((changes: NodeChange<WorkflowCanvasNode>[]) => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    if (removed.size > 0) onSelectNode("");
    const selected = changes.find((change) => change.type === "select" && change.selected);
    if (selected?.type === "select") onSelectNode(selected.id);
    if (removed.size > 0) {
      onChange({
        ...document,
        nodes: document.nodes.filter((node) => !removed.has(node.id)),
        edges: document.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)),
      });
    }
  }, [document, onChange, onSelectNode]);

  const commitNodePositions = useCallback<OnNodeDrag<WorkflowCanvasNode>>((_, draggedNode, draggedNodes) => {
    if (readonly) return;
    const positions = new Map([...draggedNodes, draggedNode].map((node) => [node.id, node.position]));
    let changed = false;
    const nodes = document.nodes.map((node) => {
      const position = positions.get(node.id);
      if (!position || samePosition(position, node.position)) return node;
      changed = true;
      return { ...node, position };
    });
    if (changed) onChange({ ...document, nodes });
  }, [document, onChange, readonly]);

  const onConnectEnd = useCallback((_: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromHandle || !state.toHandle) return;
    setConnectionNotice(connectionIssue(connectionFromHandles(state.fromHandle, state.toHandle)));
  }, [connectionIssue]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    const selected = changes.find((change) => change.type === "select" && change.selected);
    if (selected?.type === "select") {
      setSelectedEdgeId(selected.id);
      onSelectNode("");
    }
    if (removed.size > 0) {
      setSelectedEdgeId("");
      onChange({ ...document, edges: document.edges.filter((edge) => !removed.has(edge.id)) });
    }
  }, [document, onChange, onSelectNode]);

  return (
    <div className={`workflow-canvas workflow-composer-canvas overflow-hidden bg-muted/15 ${compact ? "h-64 min-h-64 rounded-md border" : "h-full min-h-0 lg:min-h-[32rem]"}`} aria-label={readonly ? "Workflow DAG canvas" : "Workflow composer canvas"}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={workflowEditorNodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStop={commitNodePositions}
        onNodeClick={(_, node) => { setSelectedEdgeId(""); onSelectNode(node.id); }}
        onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); onSelectNode(""); }}
        onPaneClick={() => { setSelectedEdgeId(""); onSelectNode(""); }}
        connectionMode={ConnectionMode.Strict}
        connectionRadius={28}
        connectionDragThreshold={2}
        connectOnClick
        nodesDraggable={!readonly}
        nodesConnectable={!readonly}
        edgesReconnectable={false}
        defaultEdgeOptions={{ type: "smoothstep" }}
        deleteKeyCode={readonly ? null : ["Backspace", "Delete"]}
        fitView
        fitViewOptions={{ padding: 0.28, maxZoom: 1 }}
        minZoom={0.35}
        maxZoom={1.6}
        snapToGrid
        snapGrid={[16, 16]}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        {connectionNotice && (
          <Panel position="top-center" className="pointer-events-none rounded-md border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm" aria-live="polite">
            {connectionNotice}
          </Panel>
        )}
        <MiniMap
          pannable
          zoomable
          className="hidden border border-border lg:block"
          bgColor="hsl(var(--card))"
          maskColor="hsl(var(--muted) / 0.6)"
          nodeColor="hsl(var(--muted-foreground) / 0.7)"
        />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

const WorkflowEditorNode = memo(function WorkflowEditorNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const node = data.definition;
  const metadata = data.metadata;
  const rowCount = Math.max(1, data.inputs.length, data.outputs.length);
  const Icon = nodeIcon(node.type);
  return (
    <div
      className={`relative w-60 rounded-md border bg-card shadow-sm transition-shadow ${selected ? "border-primary shadow-md ring-2 ring-primary/15" : "border-border"}`}
      style={{ minHeight: 72 + rowCount * 28 }}
    >
      <div className="flex min-h-14 items-start gap-2 border-b px-3 py-2.5">
        <span className="mt-0.5 rounded border bg-muted p-1 text-muted-foreground"><Icon className="h-3.5 w-3.5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{node.displayName || metadata?.displayName || node.id}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{metadata?.composite ? "Composite" : metadata?.phase || "Input"} · {node.type}</span>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 px-2 py-2 text-[11px]">
        <div className="min-w-0 space-y-1">
          {data.inputs.map((port, index) => (
            <div key={port.id} className="flex h-6 min-w-0 items-center gap-1.5 pl-2" title={`${port.label}: ${port.type}`}>
              <Handle
                id={port.id}
                type="target"
                position={Position.Left}
                className="workflow-port-handle"
                style={{ top: 70 + index * 28, "--workflow-port-color": portColor(port.type) } as CSSProperties}
                aria-label={`${node.displayName || metadata?.displayName || node.id}: ${port.label} input`}
              />
              <span className="truncate text-muted-foreground">{port.label}</span>
            </div>
          ))}
        </div>
        <div className="min-w-0 space-y-1 text-right">
          {data.outputs.map((port, index) => (
            <div key={port.id} className="flex h-6 min-w-0 items-center justify-end gap-1.5 pr-2" title={`${port.label}: ${port.type}`}>
              <span className="truncate text-muted-foreground">{port.label}</span>
              <Handle
                id={port.id}
                type="source"
                position={Position.Right}
                className="workflow-port-handle"
                style={{ top: 70 + index * 28, "--workflow-port-color": portColor(port.type) } as CSSProperties}
                aria-label={`${node.displayName || metadata?.displayName || node.id}: ${port.label} output`}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

const workflowEditorNodeTypes = { workflowEditor: WorkflowEditorNode };

function reconcileFlowNodes(
  current: WorkflowCanvasNode[],
  document: WorkflowDefinitionDocument,
  nodeTypes: WorkflowNodeType[],
  selectedNodeId: string,
) {
  const currentById = new Map(current.map((node) => [node.id, node]));
  const metadataByType = new Map(nodeTypes.map((metadata) => [metadata.type, metadata]));
  return document.nodes.map((definition): WorkflowCanvasNode => {
    const previous = currentById.get(definition.id);
    const persistedPositionChanged = !previous || !samePosition(previous.data.definition.position, definition.position);
    const ports = workflowNodePorts(document, definition, nodeTypes);
    return {
      ...previous,
      id: definition.id,
      type: "workflowEditor",
      position: persistedPositionChanged ? definition.position : previous.position,
      selected: selectedNodeId === definition.id,
      data: {
        definition,
        metadata: metadataByType.get(definition.type),
        inputs: ports.inputs,
        outputs: ports.outputs,
      },
    };
  });
}

function workflowConnectionIssue(document: WorkflowDefinitionDocument, nodeTypes: WorkflowNodeType[], connection: Connection | Edge) {
  if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return "Select an input and output port.";
  const sourceNode = document.nodes.find((node) => node.id === connection.source);
  const targetNode = document.nodes.find((node) => node.id === connection.target);
  if (!sourceNode || !targetNode) return "One of the connected nodes is no longer available.";
  const sourcePort = workflowNodePorts(document, sourceNode, nodeTypes).outputs.find((port) => port.id === connection.sourceHandle);
  const targetPort = workflowNodePorts(document, targetNode, nodeTypes).inputs.find((port) => port.id === connection.targetHandle);
  if (!sourcePort || !targetPort) return "Connect an output port to an input port.";
  if (!canConnectWorkflowPorts(sourcePort, targetPort)) return `${sourcePort.label} (${sourcePort.type}) cannot connect to ${targetPort.label} (${targetPort.type}).`;
  if (targetPort.multiple !== true && document.edges.some((edge) => edge.target === connection.target && edge.targetHandle === connection.targetHandle)) {
    return `${targetPort.label} already has a connection.`;
  }
  if (wouldCreateWorkflowCycle(document.nodes, document.edges, { source: connection.source, target: connection.target })) return "This connection would create a cycle.";
  return "";
}

function connectionFromHandles(
  from: { nodeId: string; id?: string | null; type: "source" | "target" },
  to: { nodeId: string; id?: string | null; type: "source" | "target" },
): Connection {
  if (from.type === "target") {
    return { source: to.nodeId, sourceHandle: to.id ?? null, target: from.nodeId, targetHandle: from.id ?? null };
  }
  return { source: from.nodeId, sourceHandle: from.id ?? null, target: to.nodeId, targetHandle: to.id ?? null };
}

function samePosition(left: { x: number; y: number }, right: { x: number; y: number }) {
  return left.x === right.x && left.y === right.y;
}

function nodeIcon(type: string) {
  if (type === "workflow_input") return Type;
  if (/filter/i.test(type)) return Filter;
  if (/availability|condition|branch/i.test(type)) return GitBranch;
  if (/fetch|download/i.test(type)) return Download;
  if (/tag/i.test(type)) return Tags;
  if (/template|text/i.test(type)) return Braces;
  if (/select|catalog|discover/i.test(type)) return CircleDot;
  return Workflow;
}

function portColor(type: string) {
  if (/circle|series|voice|work_code/.test(type)) return "#0ea5e9";
  if (/catalog|candidate/.test(type)) return "#8b5cf6";
  if (/available|presence/.test(type)) return "#10b981";
  if (/media|file/.test(type)) return "#f59e0b";
  if (/error|failed/.test(type)) return "#ef4444";
  return "#64748b";
}

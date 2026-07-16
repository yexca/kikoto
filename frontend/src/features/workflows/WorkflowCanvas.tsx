import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { Braces, CircleDot, Download, Filter, GitBranch, Tags, Type, Workflow } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

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
  const flowNodes = useMemo<WorkflowCanvasNode[]>(() => document.nodes.map((node) => {
    const ports = workflowNodePorts(document, node, nodeTypes);
    return {
      id: node.id,
      type: "workflowEditor",
      position: node.position,
      selected: selectedNodeId === node.id,
      data: {
        definition: node,
        metadata: nodeTypes.find((candidate) => candidate.type === node.type),
        inputs: ports.inputs,
        outputs: ports.outputs,
      },
    };
  }), [document, nodeTypes, selectedNodeId]);

  const flowEdges = useMemo<Edge[]>(() => document.edges.map((edge) => ({
    ...edge,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { strokeWidth: 1.6 },
    selected: edge.id === selectedEdgeId,
  })), [document.edges, selectedEdgeId]);

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return false;
    const sourceNode = document.nodes.find((node) => node.id === connection.source);
    const targetNode = document.nodes.find((node) => node.id === connection.target);
    if (!sourceNode || !targetNode) return false;
    const sourcePort = workflowNodePorts(document, sourceNode, nodeTypes).outputs.find((port) => port.id === connection.sourceHandle);
    const targetPort = workflowNodePorts(document, targetNode, nodeTypes).inputs.find((port) => port.id === connection.targetHandle);
    if (!canConnectWorkflowPorts(sourcePort, targetPort)) return false;
    if (targetPort?.multiple !== true && document.edges.some((edge) => edge.target === connection.target && edge.targetHandle === connection.targetHandle)) return false;
    return !wouldCreateWorkflowCycle(document.nodes, document.edges, { source: connection.source, target: connection.target });
  }, [document, nodeTypes]);

  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection) || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const edge = {
      id: createWorkflowEdgeID(connection.source, connection.sourceHandle, connection.target, connection.targetHandle),
      source: connection.source,
      sourceHandle: connection.sourceHandle,
      target: connection.target,
      targetHandle: connection.targetHandle,
    };
    onChange({ ...document, edges: [...document.edges.filter((candidate) => candidate.id !== edge.id), edge] });
  }, [document, isValidConnection, onChange]);

  const onNodesChange = useCallback((changes: NodeChange<WorkflowCanvasNode>[]) => {
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    let nextNodes = document.nodes
      .filter((node) => !removed.has(node.id))
      .map((node) => {
        const position = changes.find((change) => change.type === "position" && change.id === node.id);
        return position?.type === "position" && position.position ? { ...node, position: position.position } : node;
      });
    if (removed.size > 0) onSelectNode("");
    const selected = changes.find((change) => change.type === "select" && change.selected);
    if (selected?.type === "select") onSelectNode(selected.id);
    if (nextNodes === document.nodes) nextNodes = [...nextNodes];
    onChange({
      ...document,
      nodes: nextNodes,
      edges: removed.size > 0
        ? document.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target))
        : document.edges,
    });
  }, [document, onChange, onSelectNode]);

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
        isValidConnection={isValidConnection}
        onNodeClick={(_, node) => { setSelectedEdgeId(""); onSelectNode(node.id); }}
        onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); onSelectNode(""); }}
        onPaneClick={() => { setSelectedEdgeId(""); onSelectNode(""); }}
        connectionMode={ConnectionMode.Strict}
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
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
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

function WorkflowEditorNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
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
                className="!h-2.5 !w-2.5 !border-2 !border-card"
                style={{ top: 70 + index * 28, background: portColor(port.type) }}
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
                className="!h-2.5 !w-2.5 !border-2 !border-card"
                style={{ top: 70 + index * 28, background: portColor(port.type) }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const workflowEditorNodeTypes = { workflowEditor: WorkflowEditorNode };

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

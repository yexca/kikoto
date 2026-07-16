import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Download,
  Filter,
  GitBranch,
  Map as MapIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Save,
  Search,
  Tags,
  Trash2,
  Type,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { WorkflowCanvas } from "@/features/workflows/WorkflowCanvas";
import {
  createEmptyWorkflowDefinition,
  createWorkflowEdgeID,
  parseWorkflowDefinition,
  serializeWorkflowDefinition,
  type WorkflowDefinitionDocument,
  type WorkflowInputDefinition,
  type WorkflowInputType,
  type WorkflowNodeDefinition,
  uniqueWorkflowNodeID,
  validateWorkflowDefinition,
  workflowNodePorts,
} from "@/features/workflows/definitionModel";
import { workflowCommandUsage } from "@/features/workflows/workflowCommands";
import { api, type LibrarySource, type WorkflowDefinition, type WorkflowNodeType } from "@/lib/api";

const inputPresets: Array<{ type: WorkflowInputType; label: string; key: string }> = [
  { type: "text", label: "Text input", key: "text" },
  { type: "circle_id", label: "Circle input", key: "circle" },
  { type: "series_id", label: "Series input", key: "series" },
  { type: "voice_name", label: "Voice input", key: "voice" },
  { type: "work_code", label: "Work input", key: "work" },
];

export function WorkflowComposer({
  definition,
  nodeTypes,
  onClose,
  onDeleted,
  onSaved,
}: {
  definition: WorkflowDefinition | null;
  nodeTypes: WorkflowNodeType[];
  onClose: () => void;
  onDeleted?: () => void;
  onSaved: (definition: WorkflowDefinition) => void;
}) {
  const parsed = definition ? parseWorkflowDefinition(definition.definitionJson) : null;
  const [code, setCode] = useState(definition?.code ?? `custom_workflow_${Date.now().toString().slice(-5)}`);
  const [displayName, setDisplayName] = useState(definition?.displayName ?? "New workflow");
  const [description, setDescription] = useState(definition?.description ?? "");
  const [document, setDocument] = useState<WorkflowDefinitionDocument>(() => parsed?.kind === "v2" ? parsed.document : createStarterDocument(nodeTypes));
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(!definition);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"palette" | "inspector" | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const wideLayout = useIsWideLayout();
  const selectedNode = document.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const issues = useMemo(() => validateWorkflowDefinition(document, nodeTypes), [document, nodeTypes]);
  const errors = issues.filter((issue) => issue.level === "error");
  const visibleNodeTypes = useMemo(() => nodeTypes
    .filter((nodeType) => nodeType.type !== "workflow_input" && nodeType.userVisible && (nodeType.composite || isBusinessNodeType(nodeType.type)))
    .filter((nodeType) => `${nodeType.displayName} ${nodeType.description}`.toLowerCase().includes(paletteQuery.trim().toLowerCase())), [nodeTypes, paletteQuery]);
  const paletteVisible = wideLayout ? paletteOpen : mobilePanel === "palette";
  const inspectorVisible = wideLayout ? inspectorOpen : mobilePanel === "inspector";

  useEffect(() => {
    api.listLibrarySources().then((nextSources) => {
      setSources(nextSources);
      if (definition) return;
      const defaultSource = nextSources.find((source) => source.enabled && source.sourceType !== "local");
      if (!defaultSource) return;
      setDocument((current) => ({
        ...current,
        nodes: current.nodes.map((node) => ["voice_source_works", "check_source_availability", "track_works", "fetch_works"].includes(node.type) && !node.config?.sourceId
          ? { ...node, config: { ...node.config, sourceId: defaultSource.id } }
          : node),
      }));
    }).catch(() => setSources([]));
  }, [definition]);

  const updateDocument = (next: WorkflowDefinitionDocument) => {
    const referencedInputs = new Set(next.nodes.filter((node) => node.type === "workflow_input").map((node) => stringValue(node.config?.inputKey)));
    setDocument({ ...next, inputs: next.inputs.filter((input) => referencedInputs.has(input.key)) });
  };

  const addInput = (preset: (typeof inputPresets)[number]) => {
    const key = uniqueInputKey(preset.key, document.inputs);
    const nodeId = uniqueWorkflowNodeID(`input_${key}`, document.nodes);
    const input: WorkflowInputDefinition = { key, label: preset.label.replace(" input", ""), type: preset.type, required: true };
    setDocument({
      ...document,
      inputs: [...document.inputs, input],
      nodes: [...document.nodes, {
        id: nodeId,
        type: "workflow_input",
        displayName: input.label,
        config: { inputKey: key },
        position: nextNodePosition(document.nodes.length, true),
      }],
    });
    setSelectedNodeId(nodeId);
    openInspectorPanel();
  };

  const addNode = (metadata: WorkflowNodeType) => {
    const id = uniqueWorkflowNodeID(metadata.type, document.nodes);
    const config = nodeConfigDefaults(metadata);
    const defaultSource = sources.find((source) => source.enabled && source.sourceType !== "local");
    if (["voice_source_works", "check_source_availability", "track_works", "fetch_works"].includes(metadata.type) && defaultSource && !config.sourceId) {
      config.sourceId = defaultSource.id;
    }
    const nextNode: WorkflowNodeDefinition = {
      id,
      type: metadata.type,
      displayName: metadata.displayName,
      config,
      position: nextNodePosition(document.nodes.length, false),
    };
    setDocument({ ...document, nodes: [...document.nodes, nextNode] });
    setSelectedNodeId(id);
    openInspectorPanel();
  };

  const openInspectorPanel = () => {
    if (wideLayout) {
      setInspectorOpen(true);
      return;
    }
    setMobilePanel("inspector");
  };

  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    if (nodeId) openInspectorPanel();
  };

  const updateNode = (nodeId: string, patch: Partial<WorkflowNodeDefinition>) => {
    setDocument((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node),
    }));
  };

  const removeNode = (node: WorkflowNodeDefinition) => {
    const inputKey = node.type === "workflow_input" ? stringValue(node.config?.inputKey) : "";
    setDocument((current) => ({
      ...current,
      nodes: current.nodes.filter((candidate) => candidate.id !== node.id),
      edges: current.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id),
      inputs: inputKey ? current.inputs.filter((input) => input.key !== inputKey) : current.inputs,
    }));
    setSelectedNodeId("");
  };

  const save = async () => {
    if (errors.length > 0) return;
    setSaving(true);
    setError("");
    try {
      const payload = { code, displayName, description, definitionJson: serializeWorkflowDefinition(document) };
      const saved = definition ? await api.updateWorkflowDefinition(definition.id, payload) : await api.createWorkflowDefinition(payload);
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Workflow could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const removeDefinition = async () => {
    if (!definition?.editable || definition.scope !== "user") return;
    setDeleting(true);
    setError("");
    try {
      await api.deleteWorkflowDefinition(definition.id);
      onDeleted?.();
    } catch (cause) {
      setConfirmingDelete(false);
      setError(cause instanceof Error ? cause.message : "Workflow could not be deleted.");
    } finally {
      setDeleting(false);
    }
  };

  if (parsed?.kind === "legacy") return null;

  return (
    <div className="fixed inset-0 z-50 bg-background p-2 lg:p-4" role="dialog" aria-modal="true" aria-label={definition ? "Edit workflow" : "New workflow"}>
      <div className="mx-auto flex h-full max-w-[1560px] flex-col overflow-hidden rounded-md border bg-background shadow-xl">
        <header className="flex min-h-14 items-center gap-3 border-b px-3 lg:px-4">
          <Workflow className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{definition ? `Edit ${displayName}` : "New workflow"}</div>
            <div className="truncate text-xs text-muted-foreground">{code}</div>
          </div>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span>{document.nodes.length} nodes</span>
            <span>{document.edges.length} connections</span>
            {errors.length > 0 ? <Badge variant="warning">{errors.length} errors</Badge> : <Badge variant="secondary">Ready</Badge>}
          </div>
          {definition?.editable && definition.scope === "user" && (
            <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 hover:text-destructive" aria-label="Delete workflow" title="Delete workflow" onClick={() => setConfirmingDelete(true)} disabled={saving || deleting}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || errors.length > 0 || !displayName.trim()}>
            <Save className="h-4 w-4" />{saving ? "Saving" : "Save"}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close workflow composer" onClick={onClose}><X className="h-4 w-4" /></Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <nav className="hidden w-11 shrink-0 flex-col items-center gap-1 border-r bg-card py-2 lg:flex" aria-label="Workflow canvas tools">
            <Button variant={paletteOpen ? "secondary" : "ghost"} size="icon" aria-label={paletteOpen ? "Close node library" : "Open node library"} title={paletteOpen ? "Close node library" : "Open node library"} aria-pressed={paletteOpen} onClick={() => setPaletteOpen((open) => !open)}>
              {paletteOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
            </Button>
          </nav>

          {paletteVisible && <aside className={`app-scroll order-2 min-h-0 shrink-0 overflow-y-auto bg-card lg:order-none ${wideLayout ? "w-60 border-r" : "max-h-[38vh] min-h-48 w-full border-t"}`} aria-label="Node library">
            <div className="sticky top-0 z-10 border-b bg-card p-3">
              <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Nodes</div>
              <label className="flex h-9 items-center gap-2 rounded-md border bg-background px-2">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input className="min-w-0 flex-1 bg-transparent text-xs outline-none" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder="Find a node" />
              </label>
            </div>
            <NodePalette inputs={inputPresets} nodeTypes={visibleNodeTypes} onAddInput={addInput} onAddNode={addNode} />
          </aside>}

          <main className="order-1 flex min-h-0 min-w-0 flex-1 flex-col lg:order-none">
            <div className="flex shrink-0 items-center gap-1 border-b bg-card p-2 lg:hidden">
              <Button size="sm" variant={mobilePanel === "palette" ? "secondary" : "ghost"} aria-pressed={mobilePanel === "palette"} onClick={() => setMobilePanel((panel) => panel === "palette" ? null : "palette")}>
                <PanelLeftOpen className="h-4 w-4" />Nodes
              </Button>
              <Button size="sm" variant={mobilePanel === "inspector" ? "secondary" : "ghost"} aria-pressed={mobilePanel === "inspector"} onClick={() => setMobilePanel((panel) => panel === "inspector" ? null : "inspector")}>
                <PanelRightOpen className="h-4 w-4" />{selectedNode ? "Node" : "Workflow"}
              </Button>
              <Button size="icon" variant={showMiniMap ? "secondary" : "ghost"} className="ml-auto" aria-label={showMiniMap ? "Hide minimap" : "Show minimap"} title={showMiniMap ? "Hide minimap" : "Show minimap"} aria-pressed={showMiniMap} onClick={() => setShowMiniMap((visible) => !visible)}>
                <MapIcon className="h-4 w-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1"><WorkflowCanvas document={document} nodeTypes={nodeTypes} selectedNodeId={selectedNodeId} showMiniMap={showMiniMap} onChange={updateDocument} onSelectNode={selectNode} /></div>
          </main>

          {inspectorVisible && <aside className={`app-scroll order-2 min-h-0 shrink-0 overflow-y-auto bg-card lg:order-none ${wideLayout ? "w-[330px] border-l" : "max-h-[38vh] min-h-48 w-full border-t"}`} aria-label={selectedNode ? "Node inspector" : "Workflow inspector"}>
            {selectedNode ? (
              <NodeInspector
                node={selectedNode}
                document={document}
                nodeTypes={nodeTypes}
                sources={sources}
                issues={issues.filter((issue) => issue.nodeId === selectedNode.id)}
                onChange={(patch) => updateNode(selectedNode.id, patch)}
                onDocumentChange={setDocument}
                onRemove={() => removeNode(selectedNode)}
              />
            ) : (
              <WorkflowInspector
                code={code}
                displayName={displayName}
                description={description}
                document={document}
                editableCode={!definition}
                issues={issues}
                onCodeChange={setCode}
                onDisplayNameChange={setDisplayName}
                onDescriptionChange={setDescription}
                onDocumentChange={setDocument}
              />
            )}
          </aside>}

          <nav className="hidden w-11 shrink-0 flex-col items-center gap-1 border-l bg-card py-2 lg:flex" aria-label="Workflow view tools">
            <Button variant={inspectorOpen ? "secondary" : "ghost"} size="icon" aria-label={inspectorOpen ? "Close inspector" : "Open inspector"} title={inspectorOpen ? "Close inspector" : "Open inspector"} aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((open) => !open)}>
              {inspectorOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </Button>
            <Button variant={showMiniMap ? "secondary" : "ghost"} size="icon" aria-label={showMiniMap ? "Hide minimap" : "Show minimap"} title={showMiniMap ? "Hide minimap" : "Show minimap"} aria-pressed={showMiniMap} onClick={() => setShowMiniMap((visible) => !visible)}>
              <MapIcon className="h-4 w-4" />
            </Button>
          </nav>
        </div>
        {error && <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
      </div>
      {confirmingDelete && definition && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-background/75 p-4" onMouseDown={() => !deleting && setConfirmingDelete(false)}>
          <div className="w-full max-w-md rounded-md border bg-card p-5 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="delete-workflow-title" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="delete-workflow-title" className="text-base font-semibold">Delete workflow?</h2>
            <p className="mt-2 text-sm text-muted-foreground">Delete “{definition.displayName}”? Its definition and Quick Action will be removed. Existing run history is kept.</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(false)} disabled={deleting}>Cancel</Button>
              <Button size="sm" className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void removeDefinition()} disabled={deleting}>
                <Trash2 className="h-4 w-4" />{deleting ? "Deleting" : "Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NodePalette({
  inputs,
  nodeTypes,
  onAddInput,
  onAddNode,
}: {
  inputs: typeof inputPresets;
  nodeTypes: WorkflowNodeType[];
  onAddInput: (input: (typeof inputPresets)[number]) => void;
  onAddNode: (nodeType: WorkflowNodeType) => void;
}) {
  const groups = ["discover", "refine", "decision", "action"] as const;
  return (
    <div className="space-y-5 p-3">
      <PaletteGroup label="Inputs">
        {inputs.map((input) => <PaletteButton key={input.type} label={input.label} description={input.type} icon={<Type className="h-4 w-4" />} onClick={() => onAddInput(input)} />)}
      </PaletteGroup>
      {groups.map((group) => {
        const items = nodeTypes.filter((nodeType) => nodeGroup(nodeType) === group);
        if (items.length === 0) return null;
        return (
          <PaletteGroup key={group} label={group === "refine" ? "Refine" : group === "decision" ? "Decisions" : group === "action" ? "Actions" : "Discover"}>
            {items.map((nodeType) => <PaletteButton key={nodeType.type} label={nodeType.displayName} description={nodeType.description} icon={paletteIcon(nodeType.type)} onClick={() => onAddNode(nodeType)} />)}
          </PaletteGroup>
        );
      })}
      {nodeTypes.length === 0 && <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">No matching nodes.</div>}
    </div>
  );
}

function PaletteGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="space-y-1.5"><h3 className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</h3>{children}</section>;
}

function PaletteButton({ label, description, icon, onClick }: { label: string; description: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button className="flex w-full items-start gap-2 rounded-md border bg-background px-2.5 py-2 text-left hover:border-primary/50 hover:bg-muted/50" onClick={onClick} aria-label={label} title={description}>
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0"><span className="block truncate text-xs font-medium">{label}</span><span className="block truncate text-[10px] text-muted-foreground">{description}</span></span>
    </button>
  );
}

function WorkflowInspector({
  code,
  displayName,
  description,
  document,
  editableCode,
  issues,
  onCodeChange,
  onDisplayNameChange,
  onDescriptionChange,
  onDocumentChange,
}: {
  code: string;
  displayName: string;
  description: string;
  document: WorkflowDefinitionDocument;
  editableCode: boolean;
  issues: ReturnType<typeof validateWorkflowDefinition>;
  onCodeChange: (value: string) => void;
  onDisplayNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onDocumentChange: (document: WorkflowDefinitionDocument) => void;
}) {
  return (
    <div className="space-y-5 p-4">
      <div><h3 className="text-sm font-semibold">Workflow</h3><p className="text-xs text-muted-foreground">Definition and launch policy</p></div>
      <div className="space-y-3">
        <InspectorField label="Code"><input className={inputClass} value={code} disabled={!editableCode} onChange={(event) => onCodeChange(event.target.value)} /></InspectorField>
        <InspectorField label="Name"><input className={inputClass} value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} /></InspectorField>
        <InspectorField label="Description"><textarea className={`${inputClass} min-h-20 py-2`} value={description} onChange={(event) => onDescriptionChange(event.target.value)} /></InspectorField>
      </div>
      <section className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between gap-3"><div><div className="text-sm font-medium">Quick Action</div><div className="text-xs text-muted-foreground">Publish a slash command</div></div><Switch checked={document.command.enabled} onCheckedChange={(enabled) => onDocumentChange({ ...document, command: { ...document.command, enabled } })} aria-label="Publish as Quick Action" /></div>
        {document.command.enabled && (
          <InspectorField label="Command alias">
            <div className="flex h-9 items-center rounded-md border bg-background pl-3 focus-within:ring-2 focus-within:ring-ring"><span className="text-sm text-muted-foreground">/</span><input className="min-w-0 flex-1 bg-transparent px-1.5 text-sm outline-none" value={document.command.alias} onChange={(event) => onDocumentChange({ ...document, command: { ...document.command, alias: event.target.value } })} /></div>
            {document.command.alias && <span className="font-mono text-[11px] text-muted-foreground">{workflowCommandUsage(document.command.alias, document.inputs)}</span>}
          </InspectorField>
        )}
      </section>
      <section className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between gap-3"><div><div className="text-sm font-medium">Require preview</div><div className="text-xs text-muted-foreground">Confirm the computed plan before queueing</div></div><Switch checked={document.policy.requirePreview} onCheckedChange={(requirePreview) => onDocumentChange({ ...document, policy: { requirePreview } })} aria-label="Require workflow preview" /></div>
        {!document.policy.requirePreview && <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-muted-foreground">Bounded actions may launch after a server preview. The server rejects actions without explicit limits.</div>}
      </section>
      {issues.length > 0 && (
        <section className="space-y-2 border-t pt-4">
          <div className="text-xs font-semibold uppercase text-muted-foreground">Checks</div>
          {issues.slice(0, 8).map((issue, index) => <div key={`${issue.message}-${index}`} className="flex gap-2 text-xs text-muted-foreground">{issue.level === "error" ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" /> : <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-500" />}<span>{issue.message}</span></div>)}
        </section>
      )}
      {issues.length === 0 && <div className="flex items-center gap-2 border-t pt-4 text-xs text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-emerald-500" />Graph is ready to save.</div>}
    </div>
  );
}

function NodeInspector({
  node,
  document,
  nodeTypes,
  sources,
  issues,
  onChange,
  onDocumentChange,
  onRemove,
}: {
  node: WorkflowNodeDefinition;
  document: WorkflowDefinitionDocument;
  nodeTypes: WorkflowNodeType[];
  sources: LibrarySource[];
  issues: ReturnType<typeof validateWorkflowDefinition>;
  onChange: (patch: Partial<WorkflowNodeDefinition>) => void;
  onDocumentChange: (document: WorkflowDefinitionDocument) => void;
  onRemove: () => void;
}) {
  const metadata = nodeTypes.find((candidate) => candidate.type === node.type);
  const ports = workflowNodePorts(document, node, nodeTypes);
  const inputKey = node.type === "workflow_input" ? stringValue(node.config?.inputKey) : "";
  const workflowInput = document.inputs.find((input) => input.key === inputKey);

  return (
    <div className="space-y-5 p-4">
      <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{node.displayName || metadata?.displayName || node.id}</h3><p className="truncate text-xs text-muted-foreground">{node.type}</p></div><Button variant="outline" size="icon" aria-label="Delete selected node" onClick={onRemove}><Trash2 className="h-4 w-4" /></Button></div>
      <InspectorField label="Node name"><input className={inputClass} value={node.displayName ?? ""} onChange={(event) => onChange({ displayName: event.target.value })} /></InspectorField>
      {issues.length > 0 && <div className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive/10 p-3">{issues.map((issue, index) => <div key={`${issue.message}-${index}`} className="flex gap-2 text-xs text-destructive"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{issue.message}</span></div>)}</div>}
      {workflowInput ? (
        <InputInspector input={workflowInput} document={document} node={node} onDocumentChange={onDocumentChange} />
      ) : (
        <ConfigInspector node={node} metadata={metadata} sources={sources} onChange={onChange} />
      )}
      <section className="space-y-2 border-t pt-4">
        <div className="text-xs font-semibold uppercase text-muted-foreground">Ports</div>
        {[...ports.inputs.map((port) => ({ ...port, direction: "in" })), ...ports.outputs.map((port) => ({ ...port, direction: "out" }))].map((port) => (
          <div key={`${port.direction}-${port.id}`} className="flex items-center gap-2 text-xs"><Badge variant="outline">{port.direction}</Badge><span className="min-w-0 flex-1 truncate">{port.label}</span><span className="font-mono text-[10px] text-muted-foreground">{port.type}</span></div>
        ))}
      </section>
      {metadata?.requiredPermissions && metadata.requiredPermissions.length > 0 && <div className="border-t pt-4 text-xs text-muted-foreground">Requires {metadata.requiredPermissions.join(", ")}</div>}
    </div>
  );
}

function InputInspector({ input, document, node, onDocumentChange }: { input: WorkflowInputDefinition; document: WorkflowDefinitionDocument; node: WorkflowNodeDefinition; onDocumentChange: (document: WorkflowDefinitionDocument) => void }) {
  const update = (patch: Partial<WorkflowInputDefinition>) => {
    const next = { ...input, ...patch };
    const keyChanged = patch.key !== undefined && patch.key !== input.key;
    onDocumentChange({
      ...document,
      inputs: document.inputs.map((candidate) => candidate.key === input.key ? next : candidate),
      nodes: keyChanged ? document.nodes.map((candidate) => candidate.id === node.id ? { ...candidate, config: { ...candidate.config, inputKey: next.key } } : candidate) : document.nodes,
    });
  };
  return (
    <section className="space-y-3 border-t pt-4">
      <InspectorField label="Input key"><input className={inputClass} value={input.key} onChange={(event) => update({ key: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} /></InspectorField>
      <InspectorField label="Label"><input className={inputClass} value={input.label} onChange={(event) => update({ label: event.target.value })} /></InspectorField>
      <InspectorField label="Type"><select className={inputClass} value={input.type} onChange={(event) => update({ type: event.target.value as WorkflowInputType })}>{inputPresets.map((preset) => <option key={preset.type} value={preset.type}>{preset.type}</option>)}</select></InspectorField>
      <InspectorField label="Default value"><input className={inputClass} value={input.defaultValue ?? ""} onChange={(event) => update({ defaultValue: event.target.value || undefined })} /></InspectorField>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"><span>Required</span><Switch checked={input.required} onCheckedChange={(required) => update({ required })} aria-label="Input is required" /></div>
    </section>
  );
}

function ConfigInspector({ node, metadata, sources, onChange }: { node: WorkflowNodeDefinition; metadata?: WorkflowNodeType; sources: LibrarySource[]; onChange: (patch: Partial<WorkflowNodeDefinition>) => void }) {
  const schema = parseSchema(metadata?.configSchema);
  const fields = Object.entries(schema.properties ?? {});
  const [jsonDraft, setJsonDraft] = useState(() => JSON.stringify(node.config ?? {}, null, 2));
  const [jsonError, setJsonError] = useState("");
  useEffect(() => { setJsonDraft(JSON.stringify(node.config ?? {}, null, 2)); setJsonError(""); }, [node.id, node.config]);
  const updateConfig = (key: string, value: unknown) => onChange({ config: { ...node.config, [key]: value } });
  return (
    <section className="space-y-3 border-t pt-4">
      <div><div className="text-xs font-semibold uppercase text-muted-foreground">Configuration</div>{metadata?.description && <p className="mt-1 text-xs text-muted-foreground">{metadata.description}</p>}</div>
      {fields.map(([key, field]) => <ConfigField key={key} name={key} schema={field} value={node.config?.[key]} sources={sources} onChange={(value) => updateConfig(key, value)} />)}
      {fields.length === 0 && <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">This node has no structured options.</div>}
      <details className="group rounded-md border">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium">Advanced JSON<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" /></summary>
        <div className="border-t p-2"><textarea className="min-h-32 w-full resize-y rounded border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" value={jsonDraft} onChange={(event) => setJsonDraft(event.target.value)} onBlur={() => {
          try { const parsed = JSON.parse(jsonDraft); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); onChange({ config: parsed }); setJsonError(""); } catch { setJsonError("Config must be a JSON object."); }
        }} />{jsonError && <div className="mt-1 text-xs text-destructive">{jsonError}</div>}</div>
      </details>
    </section>
  );
}

function ConfigField({ name, schema, value, sources, onChange }: { name: string; schema: Record<string, unknown>; value: unknown; sources: LibrarySource[]; onChange: (value: unknown) => void }) {
  const label = stringValue(schema.title) || humanize(name);
  const enumValues = Array.isArray(schema.enum) ? schema.enum.map(String) : [];
  const kind = stringValue(schema.type) || inferredFieldType(name, value);
  if (/sourceId$/i.test(name)) {
    const remoteSources = sources.filter((source) => source.enabled && source.sourceType !== "local");
    return <InspectorField label="Remote source"><select className={inputClass} value={String(value ?? "")} onChange={(event) => onChange(Number(event.target.value))} disabled={remoteSources.length === 0}><option value="">{remoteSources.length > 0 ? "Select source" : "No enabled remote sources"}</option>{remoteSources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}</select></InspectorField>;
  }
  if (enumValues.length > 0) return <InspectorField label={label}><select className={inputClass} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>{enumValues.map((option) => <option key={option} value={option}>{option}</option>)}</select></InspectorField>;
  if (kind === "boolean") return <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"><span>{label}</span><Switch checked={Boolean(value)} onCheckedChange={onChange} aria-label={label} /></div>;
  if (kind === "array") return <InspectorField label={label}><input className={inputClass} value={Array.isArray(value) ? value.join(", ") : ""} onChange={(event) => onChange(event.target.value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))} placeholder="wav, flac" /></InspectorField>;
  return <InspectorField label={label}><input className={inputClass} type={kind === "number" || kind === "integer" ? "number" : "text"} value={primitiveValue(value)} min={numberOrUndefined(schema.minimum)} max={numberOrUndefined(schema.maximum)} onChange={(event) => onChange(kind === "number" || kind === "integer" ? numberInput(event.target.value) : event.target.value)} /></InspectorField>;
}

function InspectorField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5 text-xs"><span className="font-medium">{label}</span>{children}</label>;
}

const inputClass = "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";

function useIsWideLayout() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

function createStarterDocument(nodeTypes: WorkflowNodeType[]) {
  const document = createEmptyWorkflowDefinition();
  const input: WorkflowInputDefinition = { key: "circle", label: "Circle", type: "circle_id", required: true };
  const inputNode: WorkflowNodeDefinition = { id: "circle_input", type: "workflow_input", displayName: "Circle", config: { inputKey: "circle" }, position: { x: 0, y: 160 } };
  document.inputs = [input];
  document.nodes = [inputNode];
  const preferred = ["circle_catalog", "filter_works", "check_source_availability", "fetch_works"];
  for (const type of preferred) {
    const metadata = nodeTypes.find((candidate) => candidate.type === type);
    if (!metadata) continue;
    document.nodes.push({ id: type, type, displayName: metadata.displayName, config: nodeConfigDefaults(metadata), position: { x: document.nodes.length * 290, y: 160 } });
  }
  for (let index = 0; index < document.nodes.length - 1; index += 1) {
    const source = document.nodes[index];
    const target = document.nodes[index + 1];
    const output = workflowNodePorts(document, source, nodeTypes).outputs[0];
    const inputPort = workflowNodePorts(document, target, nodeTypes).inputs.find((port) => port.type === output?.type) ?? workflowNodePorts(document, target, nodeTypes).inputs[0];
    if (!output || !inputPort || output.type !== inputPort.type) continue;
    document.edges.push({ id: createWorkflowEdgeID(source.id, output.id, target.id, inputPort.id), source: source.id, sourceHandle: output.id, target: target.id, targetHandle: inputPort.id });
  }
  return document;
}

function isBusinessNodeType(type: string) {
  return ["circle_catalog", "series_catalog", "voice_source_works", "filter_works", "check_source_availability", "track_works", "fetch_works", "template_text", "tag_works"].includes(type);
}

function nodeGroup(nodeType: WorkflowNodeType) {
  if (/availability|condition|branch/i.test(nodeType.type)) return "decision";
  if (/filter|sync_metadata|template/i.test(nodeType.type)) return "refine";
  if (/track|fetch|download|tag/i.test(nodeType.type) || ["execute", "commit"].includes(nodeType.phase)) return "action";
  return "discover";
}

function paletteIcon(type: string) {
  if (/filter/i.test(type)) return <Filter className="h-4 w-4" />;
  if (/availability|condition|branch/i.test(type)) return <GitBranch className="h-4 w-4" />;
  if (/fetch|download/i.test(type)) return <Download className="h-4 w-4" />;
  if (/tag/i.test(type)) return <Tags className="h-4 w-4" />;
  return <CircleDot className="h-4 w-4" />;
}

function nextNodePosition(index: number, input: boolean) {
  return { x: input ? 0 : 280 + (index % 3) * 288, y: 80 + Math.floor(index / 3) * 176 };
}

function uniqueInputKey(base: string, inputs: WorkflowInputDefinition[]) {
  const used = new Set(inputs.map((input) => input.key));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function schemaDefaults(schemaJson: string) {
  const schema = parseSchema(schemaJson);
  return Object.fromEntries(Object.entries(schema.properties ?? {}).flatMap(([key, value]) => hasOwn(value, "default") ? [[key, value.default]] : []));
}

function nodeConfigDefaults(metadata: WorkflowNodeType) {
  const defaults: Record<string, Record<string, unknown>> = {
    circle_catalog: { mode: "stored", maxWorks: 100 },
    series_catalog: { maxWorks: 100 },
    voice_source_works: { pageSize: 48, maxPages: 10, maxWorks: 100 },
    filter_works: { limit: 100 },
    track_works: { maxWorks: 25 },
    fetch_works: { excludeExtensions: ["wav"], maxWorks: 25, maxFiles: 10000, maxBytes: 107374182400, allowUnknownSizes: false },
  };
  return { ...schemaDefaults(metadata.configSchema), ...(defaults[metadata.type] ?? {}) };
}

function parseSchema(schemaJson: string | undefined): { properties?: Record<string, Record<string, unknown>> } {
  try {
    const parsed = JSON.parse(schemaJson || "{}") as { properties?: Record<string, Record<string, unknown>> };
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function inferredFieldType(name: string, value: unknown) {
  if (Array.isArray(value) || /extensions|codes|ids|paths/i.test(name)) return "array";
  if (typeof value === "boolean" || /enabled|overwrite|force|include|allow|check/i.test(name)) return "boolean";
  if (typeof value === "number" || /count|limit|bytes|size|days|depth|minimum|maximum|sourceId|maxWorks|maxPages|maxFiles|pageSize/i.test(name)) return "number";
  return "string";
}

function humanize(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase());
}

function primitiveValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? value : "";
}

function numberInput(value: string) {
  if (!value.trim()) return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

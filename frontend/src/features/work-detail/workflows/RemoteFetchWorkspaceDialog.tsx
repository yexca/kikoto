import { AlertTriangle, HardDriveDownload, Languages, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { remoteSelectablePaths, type TreeNode } from "@/features/work-detail/media/mediaTreeModel";
import {
  canPublishRemoteFetchSelection,
  remoteDetailActionCode,
  remoteFetchExtensionSelection,
  setRemoteFetchExtensionIncluded,
} from "@/features/work-detail/workflows/remoteFetchWorkspaceModel";
import {
  buildRemoteFetchLocalTree,
  FetchPaneEmpty,
  languageLabel,
  naturalCompare,
  RemoteFetchLocalTreeNode,
  RemoteFetchResultTree,
  RemoteSelectionNode,
  remoteFetchCurrentEditionCode,
  translationKindLabel,
} from "@/features/work-detail/workflows/RemoteFetchWorkspaceTrees";
import type { RemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { type RemoteFetchFileDecision, type RemoteFetchPreparation, type RemoteWorkSavePlan } from "@/lib/api";
import { hasRemoteFetchConflicts } from "@/lib/remoteFetchPlan";

type RemoteFetchDecisions = Record<string, RemoteFetchFileDecision>;
type FetchPane = "local" | "remote" | "result";

type RemoteFetchSelectionPanelProps = {
  root: TreeNode;
  selectedPaths: Set<string>;
  selectedLocalPaths: Set<string>;
  disabled: boolean;
  readOnly?: boolean;
  plan?: RemoteWorkSavePlan | null;
  preparation?: RemoteFetchPreparation | null;
  decisions?: RemoteFetchDecisions;
  planDirty?: boolean;
  message?: string;
  onClose: () => void;
  onSave: () => void;
  onChange: (paths: Set<string>) => void;
  onLocalChange: (paths: Set<string>) => void;
  onDecisionChange?: (decision: RemoteFetchFileDecision) => void;
  activeEditionCode?: string;
  onEditionChange?: (code: string) => Promise<boolean>;
  sourceId?: number;
  targetRoot?: string;
  onTargetRootChange?: (root: string) => void;
};

export function RemoteFetchWorkspaceDialog({ workspace }: { workspace: RemoteFetchWorkspace }) {
  const { draft } = workspace;
  if (!draft) return null;
  return (
    <RemoteFetchSelectionPanel
      root={workspace.tree}
      selectedPaths={draft.selectedPaths}
      selectedLocalPaths={draft.selectedLocalPaths}
      disabled={workspace.isBusy}
      readOnly={workspace.readOnly}
      plan={draft.plan}
      preparation={draft.preparation}
      decisions={draft.decisions}
      planDirty={draft.planDirty}
      message={draft.message}
      onClose={workspace.close}
      onSave={() => void workspace.save()}
      onChange={workspace.setSelectedPaths}
      onLocalChange={workspace.setSelectedLocalPaths}
      onDecisionChange={workspace.setDecision}
      activeEditionCode={remoteDetailActionCode(draft.detail)}
      onEditionChange={workspace.selectEdition}
      sourceId={draft.intent.sourceId}
      targetRoot={draft.targetRoot}
      onTargetRootChange={workspace.setTargetRoot}
    />
  );
}

function RemoteFetchSelectionPanel({
  root,
  selectedPaths,
  selectedLocalPaths,
  disabled,
  readOnly = false,
  plan,
  preparation,
  decisions = {},
  planDirty = false,
  message = "",
  onClose,
  onSave,
  onChange,
  onLocalChange,
  onDecisionChange,
  activeEditionCode = "",
  onEditionChange,
  sourceId,
  targetRoot = "",
  onTargetRootChange,
}: RemoteFetchSelectionPanelProps) {
  const [activePane, setActivePane] = useState<FetchPane>("remote");
  const stablePreparation = preparation ?? plan?.preparation;
  const currentEditionCode = remoteFetchCurrentEditionCode(plan, activeEditionCode);
  const { selectedEditionCode, checkingEditionCode, selectEdition } = useRemoteFetchEditionSelection(
    currentEditionCode,
    onEditionChange,
  );
  const allPaths = remoteSelectablePaths(root);
  const planByPath = useMemo(() => new Map((plan?.items ?? []).map((item) => [item.path, item])), [plan]);
  const hasLocalFiles = Boolean(plan?.localFiles.length);
  const messageIsConflict = Boolean(plan && hasRemoteFetchConflicts(plan));
  const previewNeedsRefresh = !plan || planDirty;
  const previewRevision = useMemo(
    () =>
      JSON.stringify({
        edition: selectedEditionCode,
        remote: Array.from(selectedPaths).sort(naturalCompare),
        local: Array.from(selectedLocalPaths).sort(naturalCompare),
        targetRoot,
        decisions: Object.values(decisions).sort((left, right) => left.itemKey.localeCompare(right.itemKey)),
      }),
    [decisions, selectedEditionCode, selectedLocalPaths, selectedPaths, targetRoot],
  );
  const refreshScheduled = useRemoteFetchPreviewRefresh({
    disabled,
    previewNeedsRefresh,
    previewRevision,
    selectedEditionCode,
    selectedCount: selectedPaths.size + selectedLocalPaths.size,
    onSave,
  });
  useEscapeDismiss(disabled, onClose);
  const canPublish = canPublishRemoteFetchSelection({
    readOnly,
    disabled,
    refreshScheduled,
    previewNeedsRefresh,
    hasConflict: messageIsConflict,
    selectedEditionCode,
    selectedRemoteCount: selectedPaths.size,
    selectedLocalCount: selectedLocalPaths.size,
  });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-fetch-workspace-title"
        className="flex h-[calc(100dvh-2rem)] w-full max-w-7xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl md:h-[90dvh]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <RemoteFetchDialogHeader readOnly={readOnly} disabled={disabled} onClose={onClose} />
        <RemoteFetchLanguagePicker
          preparation={stablePreparation}
          plan={plan}
          activeEditionCode={activeEditionCode}
          selectedEditionCode={selectedEditionCode}
          checkingEditionCode={checkingEditionCode}
          sourceId={sourceId}
          disabled={disabled}
          onSelect={selectEdition}
        />
        <RemoteFetchSelectionToolbar
          allPaths={allPaths}
          selectedPaths={selectedPaths}
          selectedLocalPaths={selectedLocalPaths}
          plan={plan}
          readOnly={readOnly}
          disabled={disabled}
          previewNeedsRefresh={previewNeedsRefresh}
          refreshScheduled={refreshScheduled}
          onChange={onChange}
        />
        <RemoteFetchRootConflictAlert plan={plan} />
        <RemoteFetchPaneTabs activePane={activePane} hasLocalFiles={hasLocalFiles} onChange={setActivePane} />
        <RemoteFetchComparisonPanes
          root={root}
          plan={plan}
          preparation={stablePreparation}
          planByPath={planByPath}
          decisions={decisions}
          activePane={activePane}
          activeEditionCode={activeEditionCode}
          selectedPaths={selectedPaths}
          selectedLocalPaths={selectedLocalPaths}
          targetRoot={targetRoot}
          disabled={disabled}
          onRemoteChange={onChange}
          onLocalChange={onLocalChange}
          onDecisionChange={onDecisionChange}
          onTargetRootChange={onTargetRootChange}
        />
        <RemoteFetchStatus message={message} conflict={messageIsConflict} />
        <RemoteFetchFooter
          readOnly={readOnly}
          disabled={disabled}
          refreshScheduled={refreshScheduled}
          canPublish={canPublish}
          onClose={onClose}
          onSave={onSave}
        />
      </div>
    </div>
  );
}

function useRemoteFetchEditionSelection(
  currentEditionCode: string,
  onEditionChange?: (code: string) => Promise<boolean>,
) {
  const [selectedEditionCode, setSelectedEditionCode] = useState(currentEditionCode);
  const [checkingEditionCode, setCheckingEditionCode] = useState("");

  useEffect(() => {
    if (currentEditionCode) setSelectedEditionCode(currentEditionCode);
  }, [currentEditionCode]);

  const selectEdition = (code: string, selected: boolean) => {
    if (!selected) {
      setSelectedEditionCode("");
      return;
    }
    if (!onEditionChange) {
      setSelectedEditionCode(code);
      return;
    }
    setCheckingEditionCode(code);
    void onEditionChange(code)
      .then((available) => {
        if (available) setSelectedEditionCode(code);
      })
      .finally(() => setCheckingEditionCode(""));
  };

  return { selectedEditionCode, checkingEditionCode, selectEdition };
}

function useRemoteFetchPreviewRefresh({
  disabled,
  previewNeedsRefresh,
  previewRevision,
  selectedEditionCode,
  selectedCount,
  onSave,
}: {
  disabled: boolean;
  previewNeedsRefresh: boolean;
  previewRevision: string;
  selectedEditionCode: string;
  selectedCount: number;
  onSave: () => void;
}) {
  const [refreshScheduled, setRefreshScheduled] = useState(false);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (!selectedEditionCode || disabled || !previewNeedsRefresh || selectedCount === 0) {
      setRefreshScheduled(false);
      return;
    }
    setRefreshScheduled(true);
    const timer = window.setTimeout(() => {
      setRefreshScheduled(false);
      onSaveRef.current();
    }, 750);
    return () => window.clearTimeout(timer);
  }, [disabled, previewNeedsRefresh, previewRevision, selectedCount, selectedEditionCode]);

  return refreshScheduled;
}

function useEscapeDismiss(disabled: boolean, onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disabled) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, onClose]);
}

function RemoteFetchDialogHeader({
  readOnly,
  disabled,
  onClose,
}: {
  readOnly: boolean;
  disabled: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 id="remote-fetch-workspace-title" className="text-base font-semibold">
            Fetch selection
          </h3>
          {readOnly && <Badge variant="outline">Demo preview</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          Compare the exact language edition, remote source, and final published directory.
        </p>
      </div>
      <Button variant="ghost" size="icon" title="Close" onClick={onClose} disabled={disabled}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function RemoteFetchLanguagePicker({
  preparation,
  plan,
  activeEditionCode,
  selectedEditionCode,
  checkingEditionCode,
  sourceId,
  disabled,
  onSelect,
}: {
  preparation?: RemoteFetchPreparation | null;
  plan?: RemoteWorkSavePlan | null;
  activeEditionCode: string;
  selectedEditionCode: string;
  checkingEditionCode: string;
  sourceId?: number;
  disabled: boolean;
  onSelect: (code: string, selected: boolean) => void;
}) {
  if (!preparation) return null;
  const viewingEditionCode = activeEditionCode || plan?.primaryCode || "";
  return (
    <div className="flex shrink-0 items-stretch gap-2 overflow-x-auto border-b bg-muted/30 px-3 py-2">
      <div className="flex min-w-28 shrink-0 flex-col justify-center text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 font-medium uppercase tracking-wide">
          <Languages className="h-3.5 w-3.5" /> Languages
        </span>
        <span className="mt-1">
          <Badge variant={preparation.metadataStatus === "complete" ? "secondary" : "outline"}>
            {preparation.metadataStatus}
          </Badge>
        </span>
      </div>
      {preparation.editions.map((edition) => (
        <RemoteFetchEditionOption
          key={edition.primaryCode}
          edition={edition}
          viewingEditionCode={viewingEditionCode}
          selectedEditionCode={selectedEditionCode}
          checkingEditionCode={checkingEditionCode}
          sourceId={sourceId}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function RemoteFetchEditionOption({
  edition,
  viewingEditionCode,
  selectedEditionCode,
  checkingEditionCode,
  sourceId,
  disabled,
  onSelect,
}: {
  edition: RemoteFetchPreparation["editions"][number];
  viewingEditionCode: string;
  selectedEditionCode: string;
  checkingEditionCode: string;
  sourceId?: number;
  disabled: boolean;
  onSelect: (code: string, selected: boolean) => void;
}) {
  const normalizedCode = edition.primaryCode.toUpperCase();
  const viewing = viewingEditionCode.toUpperCase() === normalizedCode;
  const selected = selectedEditionCode.toUpperCase() === normalizedCode;
  const checking = checkingEditionCode.toUpperCase() === normalizedCode;
  const availableSources = edition.sources.filter((source) => source.status === "available").length;
  const selectedSourceAvailable =
    !sourceId || edition.sources.some((source) => source.sourceId === sourceId && source.status === "available");
  return (
    <label
      title={edition.title}
      className={`flex min-w-48 shrink-0 cursor-pointer items-start gap-2 rounded-md border px-3 py-1.5 text-left transition-colors ${selected ? "border-primary bg-primary/10" : "bg-background hover:bg-muted"}`}
    >
      <Checkbox
        checked={selected}
        disabled={disabled || checking}
        aria-label={`Select ${edition.primaryCode}`}
        onCheckedChange={(checked) => onSelect(edition.primaryCode, checked)}
      />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate font-semibold">
            {languageLabel(edition.metadataLanguage || edition.editionLabel)}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {translationKindLabel(edition.translationKind)}
          </span>
        </span>
        <span className="mt-1 flex items-center gap-1 whitespace-nowrap text-[10px] text-muted-foreground">
          <span className="font-mono">{edition.primaryCode}</span>
          <span>·</span>
          <span>{edition.localRoots.length} local</span>
          <span>·</span>
          <span>{availableSources} remote</span>
          <span>·</span>
          <span>{checking ? "checking" : viewing || selectedSourceAvailable ? "available" : "not checked"}</span>
        </span>
      </span>
    </label>
  );
}

function RemoteFetchSelectionToolbar({
  allPaths,
  selectedPaths,
  selectedLocalPaths,
  plan,
  readOnly,
  disabled,
  previewNeedsRefresh,
  refreshScheduled,
  onChange,
}: {
  allPaths: string[];
  selectedPaths: Set<string>;
  selectedLocalPaths: Set<string>;
  plan?: RemoteWorkSavePlan | null;
  readOnly: boolean;
  disabled: boolean;
  previewNeedsRefresh: boolean;
  refreshScheduled: boolean;
  onChange: (paths: Set<string>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b p-3">
      <Badge variant="secondary">
        {selectedPaths.size} remote / {allPaths.length}
      </Badge>
      {plan && plan.localFiles.length > 0 && <Badge variant="secondary">{selectedLocalPaths.size} local</Badge>}
      {plan && plan.summary.conflict > 0 && <Badge variant="error">{plan.summary.conflict} conflicts</Badge>}
      {plan && plan.summary.conflict === 0 && (
        <Badge variant="outline">
          {plan.summary.promote} {readOnly ? "preview only" : "to fetch"}
        </Badge>
      )}
      {previewNeedsRefresh && (
        <Badge variant="outline">
          {disabled ? "Refreshing preview" : refreshScheduled ? "Preview scheduled" : "Preview required"}
        </Badge>
      )}
      <div className="ml-auto flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => onChange(new Set(allPaths))}>
          All
        </Button>
        {(["mp3", "wav", "flac"] as const).map((extension) => (
          <RemoteFetchExtensionToggle
            key={extension}
            extension={extension}
            allPaths={allPaths}
            selectedPaths={selectedPaths}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => onChange(new Set())}>
          None
        </Button>
      </div>
    </div>
  );
}

function RemoteFetchExtensionToggle({
  extension,
  allPaths,
  selectedPaths,
  disabled,
  onChange,
}: {
  extension: string;
  allPaths: string[];
  selectedPaths: Set<string>;
  disabled: boolean;
  onChange: (paths: Set<string>) => void;
}) {
  const selection = remoteFetchExtensionSelection(allPaths, selectedPaths, extension);
  const setIncluded = (included: boolean) => {
    onChange(setRemoteFetchExtensionIncluded(allPaths, selectedPaths, extension, included));
  };
  return (
    <label className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs">
      <Checkbox
        checked={selection.checked}
        indeterminate={selection.indeterminate}
        disabled={disabled || selection.count === 0}
        onCheckedChange={() => setIncluded(!selection.checked)}
        aria-label={`Include ${extension.toUpperCase()}`}
      />
      <span>{extension.toUpperCase()}</span>
    </label>
  );
}

function RemoteFetchRootConflictAlert({ plan }: { plan?: RemoteWorkSavePlan | null }) {
  if (!plan?.fetchRoot.conflict) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 gap-2 border-b border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning-foreground"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0">
        <div className="font-medium">Fetch folder requires review</div>
        {plan.fetchRoot.rootPath && <div className="mt-0.5 break-all font-mono text-xs">{plan.fetchRoot.rootPath}</div>}
        <div className="mt-1 text-xs text-warning-foreground/80">{plan.fetchRoot.message}</div>
      </div>
    </div>
  );
}

function RemoteFetchPaneTabs({
  activePane,
  hasLocalFiles,
  onChange,
}: {
  activePane: FetchPane;
  hasLocalFiles: boolean;
  onChange: (pane: FetchPane) => void;
}) {
  const panes: FetchPane[] = hasLocalFiles ? ["local", "remote", "result"] : ["remote", "result"];
  return (
    <div className={`grid ${hasLocalFiles ? "grid-cols-3" : "grid-cols-2"} border-b bg-background p-1 md:hidden`}>
      {panes.map((pane) => (
        <Button
          key={pane}
          type="button"
          size="sm"
          variant={activePane === pane ? "secondary" : "ghost"}
          onClick={() => onChange(pane)}
          className="capitalize"
        >
          {pane}
        </Button>
      ))}
    </div>
  );
}

function RemoteFetchComparisonPanes({
  root,
  plan,
  preparation,
  planByPath,
  decisions,
  activePane,
  activeEditionCode,
  selectedPaths,
  selectedLocalPaths,
  targetRoot,
  disabled,
  onRemoteChange,
  onLocalChange,
  onDecisionChange,
  onTargetRootChange,
}: {
  root: TreeNode;
  plan?: RemoteWorkSavePlan | null;
  preparation?: RemoteFetchPreparation | null;
  planByPath: Map<string, RemoteWorkSavePlan["items"][number]>;
  decisions: RemoteFetchDecisions;
  activePane: FetchPane;
  activeEditionCode: string;
  selectedPaths: Set<string>;
  selectedLocalPaths: Set<string>;
  targetRoot: string;
  disabled: boolean;
  onRemoteChange: (paths: Set<string>) => void;
  onLocalChange: (paths: Set<string>) => void;
  onDecisionChange?: (decision: RemoteFetchFileDecision) => void;
  onTargetRootChange?: (root: string) => void;
}) {
  const hasLocalFiles = Boolean(plan?.localFiles.length);
  return (
    <div
      className={
        hasLocalFiles
          ? "grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-3"
          : "grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-2"
      }
    >
      {plan && hasLocalFiles && (
        <RemoteFetchLocalPane
          plan={plan}
          preparation={preparation}
          active={activePane === "local"}
          activeEditionCode={activeEditionCode}
          selectedPaths={selectedLocalPaths}
          targetRoot={targetRoot}
          disabled={disabled}
          onChange={onLocalChange}
          onTargetRootChange={onTargetRootChange}
        />
      )}
      <RemoteFetchRemotePane
        root={root}
        planByPath={planByPath}
        selectedPaths={selectedPaths}
        active={activePane === "remote"}
        showHeader={hasLocalFiles}
        disabled={disabled}
        onChange={onRemoteChange}
      />
      <RemoteFetchResultPane
        plan={plan}
        decisions={decisions}
        active={activePane === "result"}
        onDecisionChange={onDecisionChange}
      />
    </div>
  );
}

function RemoteFetchLocalPane({
  plan,
  preparation,
  active,
  activeEditionCode,
  selectedPaths,
  targetRoot,
  disabled,
  onChange,
  onTargetRootChange,
}: {
  plan: RemoteWorkSavePlan;
  preparation?: RemoteFetchPreparation | null;
  active: boolean;
  activeEditionCode: string;
  selectedPaths: Set<string>;
  targetRoot: string;
  disabled: boolean;
  onChange: (paths: Set<string>) => void;
  onTargetRootChange?: (root: string) => void;
}) {
  const localTree = useMemo(() => buildRemoteFetchLocalTree(plan), [plan]);
  const editionCode = (activeEditionCode || plan.primaryCode).toUpperCase();
  const activeEdition = preparation?.editions.find((edition) => edition.primaryCode.toUpperCase() === editionCode);
  const plannedRoot = activeEdition?.localRoots.find((candidate) => candidate.rootPath === plan.saveRoot);
  return (
    <div
      className={`${active ? "block" : "hidden"} app-scroll min-h-0 overflow-auto border-b p-2 md:block md:border-b-0 md:border-r`}
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div className="text-sm font-medium">Local files</div>
        <Badge variant="secondary">{selectedPaths.size} selected</Badge>
      </div>
      <label className="mb-2 block space-y-1 px-1 text-xs text-muted-foreground">
        <span>Publish target</span>
        <select
          className="h-8 w-full rounded-md border bg-background px-2 text-xs text-foreground"
          value={targetRoot || plan.saveRoot}
          disabled={disabled || !onTargetRootChange}
          onChange={(event) => onTargetRootChange?.(event.target.value)}
        >
          <option value={plan.saveRoot}>
            {plannedRoot?.role === "external" ? "Existing" : "Managed"} · {plan.saveRoot}
          </option>
          {(activeEdition?.localRoots ?? [])
            .filter((candidate) => candidate.rootPath !== plan.saveRoot)
            .map((candidate) => (
              <option key={candidate.id} value={candidate.rootPath}>
                {candidate.role === "managed_fetch" ? "Managed" : "Existing"} · {candidate.rootPath}
              </option>
            ))}
        </select>
      </label>
      <RemoteFetchLocalTreeNode
        node={localTree}
        depth={0}
        selectedLocalPaths={selectedPaths}
        disabled={disabled}
        onChange={onChange}
        isRoot
      />
    </div>
  );
}

function RemoteFetchRemotePane({
  root,
  planByPath,
  selectedPaths,
  active,
  showHeader,
  disabled,
  onChange,
}: {
  root: TreeNode;
  planByPath: Map<string, RemoteWorkSavePlan["items"][number]>;
  selectedPaths: Set<string>;
  active: boolean;
  showHeader: boolean;
  disabled: boolean;
  onChange: (paths: Set<string>) => void;
}) {
  return (
    <div
      className={`${active ? "block" : "hidden"} app-scroll min-h-0 overflow-auto border-b p-2 md:block md:border-b-0 md:border-r`}
    >
      {showHeader && (
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <div className="text-sm font-medium">Remote files</div>
          <Badge variant="secondary">{selectedPaths.size} selected</Badge>
        </div>
      )}
      <RemoteSelectionNode
        node={root}
        depth={0}
        selectedPaths={selectedPaths}
        planByPath={planByPath}
        disabled={disabled}
        onChange={onChange}
        isRoot
      />
    </div>
  );
}

function RemoteFetchResultPane({
  plan,
  decisions,
  active,
  onDecisionChange,
}: {
  plan?: RemoteWorkSavePlan | null;
  decisions: RemoteFetchDecisions;
  active: boolean;
  onDecisionChange?: (decision: RemoteFetchFileDecision) => void;
}) {
  return (
    <div className={`${active ? "block" : "hidden"} app-scroll min-h-0 overflow-auto p-2 md:block`}>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div className="text-sm font-medium">After Fetch</div>
        <Badge variant="secondary">{plan?.items.length ?? 0} files</Badge>
      </div>
      {plan ? (
        <RemoteFetchResultTree plan={plan} decisions={decisions} onDecisionChange={onDecisionChange} />
      ) : (
        <FetchPaneEmpty label="Refresh the comparison to build the result tree." />
      )}
    </div>
  );
}

function RemoteFetchStatus({ message, conflict }: { message: string; conflict: boolean }) {
  return (
    <div
      aria-live="polite"
      className={`app-scroll h-12 shrink-0 overflow-auto border-t px-3 py-2 text-sm ${conflict ? "bg-error-surface text-error-foreground" : "bg-muted text-muted-foreground"}`}
    >
      {message || (
        <span className="invisible" aria-hidden="true">
          Fetch preview status
        </span>
      )}
    </div>
  );
}

function RemoteFetchFooter({
  readOnly,
  disabled,
  refreshScheduled,
  canPublish,
  onClose,
  onSave,
}: {
  readOnly: boolean;
  disabled: boolean;
  refreshScheduled: boolean;
  canPublish: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2 border-t p-3">
      <Button variant="outline" onClick={onClose} disabled={disabled}>
        Cancel
      </Button>
      <Button onClick={onSave} disabled={!canPublish}>
        <HardDriveDownload className="h-4 w-4" />
        {readOnly ? "Preview only" : disabled || refreshScheduled ? "Refreshing preview" : "Publish Fetch"}
      </Button>
    </div>
  );
}

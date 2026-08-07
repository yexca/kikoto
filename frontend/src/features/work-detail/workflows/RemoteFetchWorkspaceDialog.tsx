import { HardDriveDownload, Languages, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { remoteSelectablePaths, type TreeNode } from "@/features/work-detail/media/mediaTreeModel";
import { remoteDetailActionCode } from "@/features/work-detail/workflows/remoteFetchWorkspaceModel";
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
}: {
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
}) {
  const [activePane, setActivePane] = useState<"local" | "remote" | "result">("remote");
  const stablePreparation = preparation ?? plan?.preparation;
  const currentEditionCode = remoteFetchCurrentEditionCode(plan, activeEditionCode);
  const [selectedEditionCode, setSelectedEditionCode] = useState(currentEditionCode);
  const [checkingEditionCode, setCheckingEditionCode] = useState("");
  const [refreshScheduled, setRefreshScheduled] = useState(false);
  const onSaveRef = useRef(onSave);
  const allPaths = remoteSelectablePaths(root);
  const planByPath = useMemo(() => new Map((plan?.items ?? []).map((item) => [item.path, item])), [plan]);
  const localTree = useMemo(() => buildRemoteFetchLocalTree(plan), [plan]);
  const hasLocalFiles = Boolean(plan?.localFiles.length);
  const activeEdition = stablePreparation?.editions.find(
    (edition) => edition.primaryCode.toUpperCase() === (activeEditionCode || plan?.primaryCode || "").toUpperCase(),
  );
  const plannedRoot = activeEdition?.localRoots.find((candidate) => candidate.rootPath === plan?.saveRoot);
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

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (currentEditionCode) setSelectedEditionCode(currentEditionCode);
  }, [currentEditionCode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disabled) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, onClose]);

  useEffect(() => {
    if (
      !selectedEditionCode ||
      disabled ||
      !previewNeedsRefresh ||
      (selectedPaths.size === 0 && selectedLocalPaths.size === 0)
    ) {
      setRefreshScheduled(false);
      return;
    }
    setRefreshScheduled(true);
    const timer = window.setTimeout(() => {
      setRefreshScheduled(false);
      onSaveRef.current();
    }, 750);
    return () => window.clearTimeout(timer);
  }, [
    disabled,
    previewNeedsRefresh,
    previewRevision,
    selectedEditionCode,
    selectedLocalPaths.size,
    selectedPaths.size,
  ]);

  const extensionSelection = (extension: string) => {
    const matching = allPaths.filter((path) => path.toLowerCase().endsWith(`.${extension}`));
    const selected = matching.filter((path) => selectedPaths.has(path)).length;
    return {
      count: matching.length,
      checked: matching.length > 0 && selected === matching.length,
      indeterminate: selected > 0 && selected < matching.length,
    };
  };
  const setExtensionIncluded = (extension: string, included: boolean) => {
    const next = new Set(selectedPaths);
    for (const path of allPaths) {
      if (!path.toLowerCase().endsWith(`.${extension}`)) continue;
      if (included) next.add(path);
      else next.delete(path);
    }
    onChange(next);
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-fetch-workspace-title"
        className="flex h-[calc(100dvh-2rem)] w-full max-w-7xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl md:h-[90dvh]"
        onMouseDown={(event) => event.stopPropagation()}
      >
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
        {stablePreparation && (
          <div className="flex shrink-0 items-stretch gap-2 overflow-x-auto border-b bg-muted/30 px-3 py-2">
            <div className="flex min-w-28 shrink-0 flex-col justify-center text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5 font-medium uppercase tracking-wide">
                <Languages className="h-3.5 w-3.5" /> Languages
              </span>
              <span className="mt-1">
                <Badge variant={stablePreparation.metadataStatus === "complete" ? "secondary" : "outline"}>
                  {stablePreparation.metadataStatus}
                </Badge>
              </span>
            </div>
            {stablePreparation.editions.map((edition) => {
              const viewing =
                (activeEditionCode || plan?.primaryCode || "").toUpperCase() === edition.primaryCode.toUpperCase();
              const selected = selectedEditionCode.toUpperCase() === edition.primaryCode.toUpperCase();
              const availableSources = edition.sources.filter((source) => source.status === "available").length;
              const selectedSourceAvailable =
                !sourceId ||
                edition.sources.some((source) => source.sourceId === sourceId && source.status === "available");
              const checking = checkingEditionCode.toUpperCase() === edition.primaryCode.toUpperCase();
              return (
                <label
                  key={edition.primaryCode}
                  title={edition.title}
                  className={`flex min-w-48 shrink-0 cursor-pointer items-start gap-2 rounded-md border px-3 py-1.5 text-left transition-colors ${selected ? "border-primary bg-primary/10" : "bg-background hover:bg-muted"}`}
                >
                  <Checkbox
                    checked={selected}
                    disabled={disabled || checking}
                    aria-label={`Select ${edition.primaryCode}`}
                    onCheckedChange={(checked) => {
                      if (!checked) {
                        setSelectedEditionCode("");
                        return;
                      }
                      if (!onEditionChange) {
                        setSelectedEditionCode(edition.primaryCode);
                        return;
                      }
                      setCheckingEditionCode(edition.primaryCode);
                      void onEditionChange(edition.primaryCode)
                        .then((available) => {
                          if (available) setSelectedEditionCode(edition.primaryCode);
                        })
                        .finally(() => setCheckingEditionCode(""));
                    }}
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
                      <span>
                        {checking ? "checking" : viewing || selectedSourceAvailable ? "available" : "not checked"}
                      </span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Badge variant="secondary">
            {selectedPaths.size} remote / {allPaths.length}
          </Badge>
          {plan && plan.localFiles.length > 0 && <Badge variant="secondary">{selectedLocalPaths.size} local</Badge>}
          {plan && plan.summary.conflict > 0 && (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              {plan.summary.conflict} conflicts
            </Badge>
          )}
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
            {(["mp3", "wav", "flac"] as const).map((extension) => {
              const state = extensionSelection(extension);
              return (
                <label
                  key={extension}
                  className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs"
                >
                  <Checkbox
                    checked={state.checked}
                    indeterminate={state.indeterminate}
                    disabled={disabled || state.count === 0}
                    onCheckedChange={() => setExtensionIncluded(extension, !state.checked)}
                    aria-label={`Include ${extension.toUpperCase()}`}
                  />
                  <span>{extension.toUpperCase()}</span>
                </label>
              );
            })}
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => onChange(new Set())}>
              None
            </Button>
          </div>
        </div>
        <div className={`grid ${hasLocalFiles ? "grid-cols-3" : "grid-cols-2"} border-b bg-background p-1 md:hidden`}>
          {(hasLocalFiles ? (["local", "remote", "result"] as const) : (["remote", "result"] as const)).map((pane) => (
            <Button
              key={pane}
              type="button"
              size="sm"
              variant={activePane === pane ? "secondary" : "ghost"}
              onClick={() => setActivePane(pane)}
              className="capitalize"
            >
              {pane}
            </Button>
          ))}
        </div>
        <div
          className={
            hasLocalFiles
              ? "grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-3"
              : "grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-2"
          }
        >
          {hasLocalFiles && (
            <div
              className={`${activePane === "local" ? "block" : "hidden"} app-scroll min-h-0 overflow-auto border-b p-2 md:block md:border-b-0 md:border-r`}
            >
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="text-sm font-medium">Local files</div>
                <Badge variant="secondary">{selectedLocalPaths.size} selected</Badge>
              </div>
              {plan && (
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
              )}
              <RemoteFetchLocalTreeNode
                node={localTree}
                depth={0}
                selectedLocalPaths={selectedLocalPaths}
                disabled={disabled}
                onChange={onLocalChange}
                isRoot
              />
            </div>
          )}
          <div
            className={`${activePane === "remote" ? "block" : "hidden"} app-scroll min-h-0 overflow-auto border-b p-2 md:block md:border-b-0 md:border-r`}
          >
            {hasLocalFiles && (
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
          <div
            className={`${activePane === "result" ? "block" : "hidden"} app-scroll min-h-0 overflow-auto p-2 md:block`}
          >
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
        </div>
        <div
          aria-live="polite"
          className={`app-scroll h-12 shrink-0 overflow-auto border-t px-3 py-2 text-sm ${messageIsConflict ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
        >
          {message || (
            <span className="invisible" aria-hidden="true">
              Fetch preview status
            </span>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t p-3">
          <Button variant="outline" onClick={onClose} disabled={disabled}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={
              readOnly ||
              disabled ||
              refreshScheduled ||
              previewNeedsRefresh ||
              messageIsConflict ||
              !selectedEditionCode ||
              (selectedPaths.size === 0 && selectedLocalPaths.size === 0)
            }
          >
            <HardDriveDownload className="h-4 w-4" />
            {readOnly ? "Preview only" : disabled || refreshScheduled ? "Refreshing preview" : "Publish Fetch"}
          </Button>
        </div>
      </div>
    </div>
  );
}

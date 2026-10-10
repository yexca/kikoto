import { AlertTriangle, CheckCircle2, Clock3, HardDrive, HardDriveDownload, Info, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { formatBytes, remoteSelectablePaths, type TreeNode } from "@/features/work-detail/media/mediaTreeModel";
import {
  canPublishRemoteFetchSelection,
  editionLocalRoots,
  remoteDetailActionCode,
  remoteFetchExtensions,
  remoteFetchExtensionSelection,
  remoteFetchSelectedBytes,
  selectableFetchTargetRoots,
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
import { cn } from "@/lib/tailwindClassNames";
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
  workCode?: string;
  workTitle?: string;
  sourceName?: string;
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
      workCode={remoteDetailActionCode(draft.detail)}
      workTitle={draft.detail.title}
      sourceName={draft.intent.sourceDisplayName || draft.detail.sourceName}
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
  workCode = "",
  workTitle = "",
  sourceName = "",
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
  const { t } = useTranslation();
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
  const hasConflict = Boolean(plan && hasRemoteFetchConflicts(plan));
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
  const canPublish = canPublishRemoteFetchSelection({
    readOnly,
    disabled,
    refreshScheduled,
    previewNeedsRefresh,
    hasConflict,
    selectedEditionCode,
    selectedRemoteCount: selectedPaths.size,
    selectedLocalCount: selectedLocalPaths.size,
  });
  const selectedBytes = useMemo(() => remoteFetchSelectedBytes(root, selectedPaths), [root, selectedPaths]);
  const sourcePane: FetchPane = activePane === "local" && hasLocalFiles ? "local" : "remote";
  return (
    <Dialog
      onClose={onClose}
      size="full"
      dismissible={!disabled}
      ariaLabel={t("remoteFetch.title")}
      marker="remote-fetch"
      className="h-[var(--dialog-max-height)] max-w-7xl bg-background md:h-[min(90dvh,var(--dialog-max-height))]"
    >
      <RemoteFetchDialogHeader
        readOnly={readOnly}
        disabled={disabled}
        workCode={plan?.primaryCode || workCode}
        workTitle={workTitle}
        sourceName={sourceName}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)_minmax(0,25rem)]">
        <aside
          aria-label={t("remoteFetch.edition")}
          className="app-scroll shrink-0 border-b bg-muted/30 lg:min-h-0 lg:overflow-auto lg:border-b-0 lg:border-r"
        >
          <RemoteFetchEditionPicker
            preparation={stablePreparation}
            plan={plan}
            activeEditionCode={activeEditionCode}
            selectedEditionCode={selectedEditionCode}
            checkingEditionCode={checkingEditionCode}
            sourceId={sourceId}
            disabled={disabled}
            onSelect={selectEdition}
          />
          <RemoteFetchPlanSummary plan={plan} preparation={stablePreparation} selectedBytes={selectedBytes} />
        </aside>
        {/* A blocking folder review stays visible on mobile instead of hiding behind the result tab. */}
        {plan?.fetchRoot.conflict && (
          <div className="shrink-0 border-b px-3 py-2 lg:hidden">
            <RemoteFetchRootConflictAlert plan={plan} />
          </div>
        )}
        <RemoteFetchPaneTabs
          activePane={activePane}
          hasLocalFiles={hasLocalFiles}
          remoteCount={selectedPaths.size}
          localCount={selectedLocalPaths.size}
          resultCount={plan?.items.length ?? 0}
          resultBlocked={hasConflict}
          onChange={setActivePane}
          className="lg:hidden"
        />
        <section
          className={cn(
            "min-h-0 flex-1 flex-col bg-card lg:flex lg:border-r",
            activePane === "result" ? "hidden" : "flex",
          )}
        >
          {hasLocalFiles && (
            <RemoteFetchPaneTabs
              activePane={sourcePane}
              hasLocalFiles
              remoteCount={selectedPaths.size}
              localCount={selectedLocalPaths.size}
              onChange={setActivePane}
              className="hidden lg:flex"
            />
          )}
          {sourcePane === "local" && plan ? (
            <RemoteFetchLocalPane
              plan={plan}
              selectedPaths={selectedLocalPaths}
              disabled={disabled}
              onChange={onLocalChange}
            />
          ) : (
            <RemoteFetchRemotePane
              root={root}
              allPaths={allPaths}
              planByPath={planByPath}
              selectedPaths={selectedPaths}
              selectedBytes={selectedBytes}
              showHeading={!hasLocalFiles}
              disabled={disabled}
              onChange={onChange}
            />
          )}
        </section>
        <RemoteFetchResultPane
          plan={plan}
          preparation={stablePreparation}
          decisions={decisions}
          activeEditionCode={activeEditionCode}
          message={hasConflict && !plan?.fetchRoot.conflict ? message : ""}
          targetRoot={targetRoot}
          disabled={disabled}
          active={activePane === "result"}
          onDecisionChange={onDecisionChange}
          onTargetRootChange={onTargetRootChange}
        />
      </div>
      <RemoteFetchFooter
        plan={plan}
        readOnly={readOnly}
        disabled={disabled}
        refreshScheduled={refreshScheduled}
        previewNeedsRefresh={previewNeedsRefresh}
        hasConflict={hasConflict}
        canPublish={canPublish}
        onReviewConflicts={() => setActivePane("result")}
        onClose={onClose}
        onSave={onSave}
      />
    </Dialog>
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

  const selectEdition = (code: string) => {
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

function RemoteFetchDialogHeader({
  readOnly,
  disabled,
  workCode,
  workTitle,
  sourceName,
  onClose,
}: {
  readOnly: boolean;
  disabled: boolean;
  workCode: string;
  workTitle: string;
  sourceName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-start gap-3 border-b px-4 py-3 sm:px-5">
      <div className="mt-0.5 hidden h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary sm:grid">
        <HardDriveDownload className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-base font-semibold leading-6">{t("remoteFetch.title")}</h3>
          {readOnly && <Badge variant="outline">{t("remoteFetch.demoPreview")}</Badge>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {workCode && (
            <span className="shrink-0 rounded border bg-muted/60 px-1.5 py-px font-mono text-2xs text-foreground">
              {workCode}
            </span>
          )}
          {workTitle && (
            <span className="min-w-0 truncate" title={workTitle}>
              {workTitle}
            </span>
          )}
          {sourceName && (
            <span className="hidden shrink-0 sm:inline">· {t("remoteFetch.fromSource", { source: sourceName })}</span>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="-mr-1.5 shrink-0"
        title={t("remoteFetch.close")}
        aria-label={t("remoteFetch.close")}
        onClick={onClose}
        disabled={disabled}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-2xs font-medium uppercase tracking-wide text-muted-foreground", className)}>
      {children}
    </div>
  );
}

function RemoteFetchEditionPicker({
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
  onSelect: (code: string) => void;
}) {
  const { t } = useTranslation();
  if (!preparation) return null;
  const viewingEditionCode = activeEditionCode || plan?.primaryCode || "";
  return (
    <div className="px-3 py-2.5 lg:p-4">
      <SectionLabel className="mb-2 hidden lg:block">{t("remoteFetch.edition")}</SectionLabel>
      <div
        role="radiogroup"
        aria-label={t("remoteFetch.languages")}
        className="app-scroll -mx-3 flex gap-2 overflow-x-auto overflow-y-hidden px-3 pb-0.5 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
      >
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
  onSelect: (code: string) => void;
}) {
  const { t } = useTranslation();
  const normalizedCode = edition.primaryCode.toUpperCase();
  const viewing = viewingEditionCode.toUpperCase() === normalizedCode;
  const selected = selectedEditionCode.toUpperCase() === normalizedCode;
  const checking = checkingEditionCode.toUpperCase() === normalizedCode;
  const selectedSourceAvailable =
    !sourceId || edition.sources.some((source) => source.sourceId === sourceId && source.status === "available");
  const available = viewing || selectedSourceAvailable;
  const localRoots = editionLocalRoots(edition).length;
  return (
    <label
      title={edition.title}
      className={cn(
        "group relative flex min-w-44 shrink-0 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors focus-within:ring-2 focus-within:ring-ring lg:min-w-0",
        selected ? "border-primary bg-primary/[0.07]" : "bg-background hover:border-foreground/20 hover:bg-muted/50",
        (disabled || checking) && "cursor-default opacity-70",
      )}
    >
      <input
        type="radio"
        name="remote-fetch-edition"
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-lg opacity-0 disabled:cursor-default"
        checked={selected}
        disabled={disabled || checking}
        aria-label={t("remoteFetch.selectEdition", { code: edition.primaryCode })}
        onChange={() => onSelect(edition.primaryCode)}
      />
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors",
          selected ? "border-primary" : "border-input bg-background",
        )}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium">
          {languageLabel(edition.metadataLanguage || edition.editionLabel, t)}
        </span>
        <span className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-2xs text-muted-foreground">
          <span className="font-mono">{edition.primaryCode}</span>
          <span aria-hidden="true">·</span>
          <span>{translationKindLabel(edition.translationKind, t)}</span>
        </span>
        <span className="mt-1.5 flex items-center gap-2 whitespace-nowrap text-2xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            {checking ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <span
                aria-hidden="true"
                className={cn("h-1.5 w-1.5 rounded-full", available ? "bg-success" : "bg-muted-foreground/40")}
              />
            )}
            {checking
              ? t("remoteFetch.checking")
              : available
                ? t("remoteFetch.available")
                : t("remoteFetch.notChecked")}
          </span>
          {localRoots > 0 && (
            <span className="inline-flex items-center gap-1" title={t("remoteFetch.localCount", { count: localRoots })}>
              <HardDrive className="h-3 w-3" />
              {t("remoteFetch.inLibrary")}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}

function RemoteFetchPlanSummary({
  plan,
  preparation,
  selectedBytes,
}: {
  plan?: RemoteWorkSavePlan | null;
  preparation?: RemoteFetchPreparation | null;
  selectedBytes: number | null;
}) {
  const { t } = useTranslation();
  const metadataStatus = preparation?.metadataStatus ?? "complete";
  const warning = preparation?.warnings[0];
  const rows: { label: string; value: number; tone?: "error" }[] = plan
    ? [
        { label: t("remoteFetch.summaryDownload"), value: plan.summary.cacheDownload },
        { label: t("remoteFetch.summaryCached"), value: plan.summary.cacheHit },
        { label: t("remoteFetch.summaryExisting"), value: plan.summary.skipExisting },
        { label: t("remoteFetch.summaryConflicts"), value: plan.summary.conflict, tone: "error" },
      ]
    : [];
  return (
    <div className="hidden border-t px-4 py-4 lg:block">
      <SectionLabel className="mb-2">{t("remoteFetch.summary")}</SectionLabel>
      {plan ? (
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{t("remoteFetch.summaryTotal")}</dt>
            <dd className="font-medium tabular-nums">{plan.summary.total}</dd>
          </div>
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd
                className={cn(
                  "tabular-nums",
                  row.value === 0 && "text-muted-foreground/60",
                  row.tone === "error" && row.value > 0 && "font-medium text-error-foreground",
                )}
              >
                {row.value}
              </dd>
            </div>
          ))}
          {selectedBytes !== null && (
            <div className="flex items-baseline justify-between gap-3 border-t pt-1.5">
              <dt className="text-muted-foreground">{t("remoteFetch.summarySize")}</dt>
              <dd className="tabular-nums">{formatBytes(selectedBytes)}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">{t("remoteFetch.refreshComparison")}</p>
      )}
      {preparation && (metadataStatus !== "complete" || warning) && (
        <div className="mt-4 flex gap-2 rounded-md border border-info-border bg-info-surface px-2.5 py-2 text-xs text-info-foreground">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">{t(`remoteFetch.metadataState.${metadataStatus}`)}</div>
            {warning && <div className="mt-0.5 opacity-80">{warning}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function RemoteFetchPaneTabs({
  activePane,
  hasLocalFiles,
  remoteCount,
  localCount,
  resultCount,
  resultBlocked = false,
  className,
  onChange,
}: {
  activePane: FetchPane;
  hasLocalFiles: boolean;
  remoteCount: number;
  localCount: number;
  resultCount?: number;
  resultBlocked?: boolean;
  className?: string;
  onChange: (pane: FetchPane) => void;
}) {
  const { t } = useTranslation();
  const panes: { pane: FetchPane; label: string; count: number; alert?: boolean }[] = [
    { pane: "remote", label: t("remoteFetch.remoteFiles"), count: remoteCount },
    ...(hasLocalFiles ? [{ pane: "local" as const, label: t("remoteFetch.localFiles"), count: localCount }] : []),
    ...(resultCount === undefined
      ? []
      : [{ pane: "result" as const, label: t("remoteFetch.afterFetch"), count: resultCount, alert: resultBlocked }]),
  ];
  return (
    <div className={cn("flex shrink-0 gap-1 border-b bg-background px-3 py-2 lg:px-4", className)}>
      <div className="flex min-w-0 flex-1 gap-1 rounded-lg bg-muted p-1 lg:flex-none">
        {panes.map(({ pane, label, count, alert }) => {
          const active = activePane === pane;
          return (
            <button
              key={pane}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(pane)}
              className={cn(
                "inline-flex min-h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs sm:px-3 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex-none",
                active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="truncate">{label}</span>
              <span
                aria-hidden="true"
                className={cn(
                  "rounded-full px-1.5 text-3xs tabular-nums",
                  alert ? "bg-error-surface text-error-foreground" : active ? "bg-muted" : "bg-background/60",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RemoteFetchRemotePane({
  root,
  allPaths,
  planByPath,
  selectedPaths,
  selectedBytes,
  showHeading,
  disabled,
  onChange,
}: {
  root: TreeNode;
  allPaths: string[];
  planByPath: Map<string, RemoteWorkSavePlan["items"][number]>;
  selectedPaths: Set<string>;
  selectedBytes: number | null;
  showHeading: boolean;
  disabled: boolean;
  onChange: (paths: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const extensions = useMemo(() => remoteFetchExtensions(allPaths).slice(0, 5), [allPaths]);
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5 lg:px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {showHeading && <div className="text-sm font-medium">{t("remoteFetch.remoteFiles")}</div>}
            <div className="truncate text-xs tabular-nums text-muted-foreground">
              {t("remoteFetch.selectionSummary", { selected: selectedPaths.size, total: allPaths.length })}
              {selectedBytes !== null && selectedPaths.size > 0 && <> · {formatBytes(selectedBytes)}</>}
            </div>
          </div>
          <div className="-mr-2 flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(new Set(allPaths))}>
              {t("remoteFetch.all")}
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(new Set())}>
              {t("remoteFetch.none")}
            </Button>
          </div>
        </div>
        <div role="group" aria-label={t("remoteFetch.fileTypes")} className="flex flex-wrap items-center gap-1.5">
          {extensions.map(({ extension }) => (
            <RemoteFetchExtensionToggle
              key={extension}
              extension={extension}
              allPaths={allPaths}
              selectedPaths={selectedPaths}
              disabled={disabled}
              onChange={onChange}
            />
          ))}
        </div>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
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
    </>
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
  const { t } = useTranslation();
  const selection = remoteFetchExtensionSelection(allPaths, selectedPaths, extension);
  const active = selection.checked || selection.indeterminate;
  const setIncluded = (included: boolean) => {
    onChange(setRemoteFetchExtensionIncluded(allPaths, selectedPaths, extension, included));
  };
  return (
    <label
      className={cn(
        "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border pl-1.5 pr-2.5 text-xs transition-colors",
        active ? "border-primary/40 bg-primary/[0.07]" : "bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      <Checkbox
        className="h-4 w-4 rounded-full"
        checked={selection.checked}
        indeterminate={selection.indeterminate}
        disabled={disabled || selection.count === 0}
        onCheckedChange={() => setIncluded(!selection.checked)}
        aria-label={t("remoteFetch.include", { extension: extension.toUpperCase() })}
      />
      <span className="font-medium">{extension.toUpperCase()}</span>
      <span className="tabular-nums text-muted-foreground">{selection.count}</span>
    </label>
  );
}

function RemoteFetchLocalPane({
  plan,
  selectedPaths,
  disabled,
  onChange,
}: {
  plan: RemoteWorkSavePlan;
  selectedPaths: Set<string>;
  disabled: boolean;
  onChange: (paths: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const localTree = useMemo(() => buildRemoteFetchLocalTree(plan), [plan]);
  const allLocalPaths = plan.localFiles.map((file) => file.path);
  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-3 border-b px-3 py-2.5 lg:px-4">
        <p className="text-xs text-muted-foreground">{t("remoteFetch.localHint")}</p>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(new Set(allLocalPaths))}>
            {t("remoteFetch.all")}
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(new Set())}>
            {t("remoteFetch.none")}
          </Button>
        </div>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
        <RemoteFetchLocalTreeNode
          node={localTree}
          depth={0}
          selectedLocalPaths={selectedPaths}
          disabled={disabled}
          onChange={onChange}
          isRoot
        />
      </div>
    </>
  );
}

function RemoteFetchResultPane({
  plan,
  preparation,
  decisions,
  activeEditionCode,
  message,
  targetRoot,
  disabled,
  active,
  onDecisionChange,
  onTargetRootChange,
}: {
  plan?: RemoteWorkSavePlan | null;
  preparation?: RemoteFetchPreparation | null;
  decisions: RemoteFetchDecisions;
  activeEditionCode: string;
  message: string;
  targetRoot: string;
  disabled: boolean;
  active: boolean;
  onDecisionChange?: (decision: RemoteFetchFileDecision) => void;
  onTargetRootChange?: (root: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("remoteFetch.afterFetch")}
      className={cn("min-h-0 flex-1 flex-col bg-card lg:flex", active ? "flex" : "hidden")}
    >
      <div className="shrink-0 space-y-2.5 border-b px-3 py-2.5 lg:px-4">
        <div className="hidden items-center justify-between gap-2 lg:flex">
          <div className="text-sm font-medium">{t("remoteFetch.afterFetch")}</div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("remoteFetch.files", { count: plan?.items.length ?? 0 })}
          </span>
        </div>
        {plan && (
          <RemoteFetchTargetSelect
            plan={plan}
            preparation={preparation}
            activeEditionCode={activeEditionCode}
            targetRoot={targetRoot}
            disabled={disabled}
            onTargetRootChange={onTargetRootChange}
          />
        )}
        <RemoteFetchRootConflictAlert plan={plan} className="hidden lg:flex" />
        {message && (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-error-border bg-error-surface px-2.5 py-2 text-xs text-error-foreground"
          >
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 break-words">{message}</div>
          </div>
        )}
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
        {plan ? (
          <RemoteFetchResultTree plan={plan} decisions={decisions} onDecisionChange={onDecisionChange} />
        ) : (
          <FetchPaneEmpty label={t("remoteFetch.refreshComparison")} />
        )}
      </div>
    </section>
  );
}

function RemoteFetchTargetSelect({
  plan,
  preparation,
  activeEditionCode,
  targetRoot,
  disabled,
  onTargetRootChange,
}: {
  plan: RemoteWorkSavePlan;
  preparation?: RemoteFetchPreparation | null;
  activeEditionCode: string;
  targetRoot: string;
  disabled: boolean;
  onTargetRootChange?: (root: string) => void;
}) {
  const { t } = useTranslation();
  const editionCode = (activeEditionCode || plan.primaryCode).toUpperCase();
  const activeEdition = preparation?.editions.find((edition) => edition.primaryCode.toUpperCase() === editionCode);
  const plannedRoot = editionLocalRoots(activeEdition).find((candidate) => candidate.rootPath === plan.saveRoot);
  return (
    <label className="block space-y-1 text-xs text-muted-foreground">
      <span>{t("remoteFetch.publishTarget")}</span>
      <NativeSelect
        fieldSize="sm"
        className="h-8 w-full px-2 font-mono text-xs"
        value={targetRoot || plan.saveRoot}
        disabled={disabled || !onTargetRootChange}
        onChange={(event) => onTargetRootChange?.(event.target.value)}
      >
        <option value={plan.saveRoot}>
          {plannedRoot?.role === "external" ? t("remoteFetch.existing") : t("remoteFetch.managed")} · {plan.saveRoot}
        </option>
        {selectableFetchTargetRoots(activeEdition, plan.saveRoot).map((candidate) => (
          <option key={candidate.id} value={candidate.rootPath}>
            {candidate.role === "managed_fetch" ? t("remoteFetch.managed") : t("remoteFetch.existing")} ·{" "}
            {candidate.rootPath}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

function RemoteFetchRootConflictAlert({ plan, className }: { plan?: RemoteWorkSavePlan | null; className?: string }) {
  const { t } = useTranslation();
  if (!plan?.fetchRoot.conflict) return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex gap-2 rounded-md border border-warning-border bg-warning-surface px-2.5 py-2 text-xs text-warning-foreground",
        className,
      )}
    >
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
      <div className="min-w-0">
        <div className="font-medium">{t("remoteFetch.fetchFolderReview")}</div>
        {plan.fetchRoot.rootPath && <div className="mt-0.5 break-all font-mono">{plan.fetchRoot.rootPath}</div>}
        <div className="mt-1 text-warning-foreground/80">{plan.fetchRoot.message}</div>
      </div>
    </div>
  );
}

function RemoteFetchFooter({
  plan,
  readOnly,
  disabled,
  refreshScheduled,
  previewNeedsRefresh,
  hasConflict,
  canPublish,
  onReviewConflicts,
  onClose,
  onSave,
}: {
  plan?: RemoteWorkSavePlan | null;
  readOnly: boolean;
  disabled: boolean;
  refreshScheduled: boolean;
  previewNeedsRefresh: boolean;
  hasConflict: boolean;
  canPublish: boolean;
  onReviewConflicts: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const refreshing = disabled || refreshScheduled;
  const conflictCount = plan ? Math.max(plan.summary.conflict, plan.fetchRoot.conflict ? 1 : 0) : 0;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t bg-muted/35 px-3 py-2.5 sm:px-5">
      <div
        aria-live="polite"
        className="flex min-h-8 min-w-0 basis-full items-center gap-2 text-sm sm:basis-0 sm:flex-1"
      >
        {previewNeedsRefresh && refreshing ? (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <span className="truncate text-muted-foreground">
              {disabled ? t("remoteFetch.refreshingPreview") : t("remoteFetch.previewScheduled")}
            </span>
          </>
        ) : previewNeedsRefresh ? (
          <>
            <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-muted-foreground">{t("remoteFetch.previewRequired")}</span>
          </>
        ) : hasConflict ? (
          <>
            <AlertTriangle className="h-4 w-4 shrink-0 text-error" />
            <span className="truncate text-error-foreground">
              {t("remoteFetch.statusBlocked", { count: conflictCount })}
            </span>
            <Button variant="ghost" size="sm" className="shrink-0 px-2 lg:hidden" onClick={onReviewConflicts}>
              {t("remoteFetch.review")}
            </Button>
          </>
        ) : plan ? (
          <>
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            <span className="truncate">
              {readOnly
                ? t("remoteFetch.statusPreviewOnly", { count: plan.summary.promote })
                : t("remoteFetch.statusReady", { count: plan.summary.promote })}
            </span>
          </>
        ) : null}
      </div>
      <div className="ml-auto flex gap-2">
        <Button variant="outline" onClick={onClose} disabled={disabled}>
          {t("remoteFetch.cancel")}
        </Button>
        <Button onClick={onSave} disabled={!canPublish}>
          <HardDriveDownload className="h-4 w-4" />
          {readOnly ? t("remoteFetch.previewOnly") : t("remoteFetch.publishFetch")}
        </Button>
      </div>
    </div>
  );
}

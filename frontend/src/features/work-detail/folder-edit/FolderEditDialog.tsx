import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  FolderCog,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { ConfirmMediaBatchDeleteDialog } from "@/features/work-detail/dialogs/ConfirmMediaBatchDeleteDialog";
import {
  buildFolderEditTree,
  folderEditExtensions,
  folderEditResourceChanges,
  folderEditSelectedBytes,
  withFolderEditPaths,
  type FolderEditFile,
  type FolderEditResource,
  type FolderEditTarget,
} from "@/features/work-detail/folder-edit/folderEditModel";
import {
  ColumnLabel,
  PaneNote,
  PaneSwitch,
  ResourceOption,
  ResultNode,
  SelectionNode,
} from "@/features/work-detail/folder-edit/FolderEditPanes";
import {
  useFolderEditWorkspace,
  type FolderEditInitialRemote,
  type FolderEditWorkspace,
} from "@/features/work-detail/folder-edit/useFolderEditWorkspace";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { languageLabel } from "@/features/work-detail/workflows/RemoteFetchWorkspaceTrees";
import type { MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import type { MediaItem, WorkFolderEditResult } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

type EditPane = "sources" | "select" | "result";

const noSelection: ReadonlySet<string> = new Set();

/**
 * Edits one local folder of a work in three columns: where files can come
 * from, the files of the chosen place, and the folder as it will be. The
 * edited folder is the first place; clearing a file there removes it.
 */
export function FolderEditDialog({
  workId,
  folder,
  currentItems,
  initialRemote,
  onBack,
  onClose,
  onApplied,
}: {
  workId: number;
  folder: { id: number; rootPath: string };
  currentItems: MediaItem[];
  initialRemote?: FolderEditInitialRemote | null;
  /** Returns to the folder's own file list. */
  onBack?: () => void;
  onClose: () => void;
  onApplied: (result: WorkFolderEditResult) => void;
}) {
  const { t } = useTranslation();
  const target = useMemo<FolderEditTarget>(
    () => ({ workId, folderId: folder.id, rootPath: folder.rootPath }),
    [folder.id, folder.rootPath, workId],
  );
  const workspace = useFolderEditWorkspace({ target, currentItems, initialRemote, onApplied });
  const [pane, setPane] = useState<EditPane>(initialRemote ? "select" : "sources");
  const [confirmation, setConfirmation] = useState<{ step: 1 | 2; targets: MediaDeleteTarget[] } | null>(null);
  const removalTargets = useMemo<MediaDeleteTarget[]>(
    () =>
      workspace.removedFiles
        .filter((file) => file.locationId !== null)
        .map((file) => ({
          kind: "local",
          locationId: file.locationId!,
          workId,
          title: file.name,
          path: `${target.rootPath.replace(/\/+$/, "")}/${file.path}`,
          sizeBytes: file.sizeBytes,
        })),
    [target.rootPath, workId, workspace.removedFiles],
  );
  const startApply = () => {
    if (removalTargets.length > 0) setConfirmation({ step: 1, targets: removalTargets });
    else void workspace.apply();
  };
  const paneCounts: Record<EditPane, number> = {
    sources: workspace.resources.length,
    select: workspace.request.additions.length,
    result: workspace.result.filter((entry) => entry.state !== "remove" && entry.state !== "excluded").length,
  };

  return (
    <>
      <Dialog
        onClose={onClose}
        size="full"
        dismissible={!workspace.applying}
        marker="folder-edit"
        className="h-[var(--dialog-max-height)] max-w-7xl bg-background md:h-[min(90dvh,var(--dialog-max-height))]"
      >
        <DialogHeader
          title={t("folderEdit.title")}
          description={t("folderEdit.description")}
          icon={<FolderCog className="h-4 w-4" />}
          onClose={onClose}
          closeLabel={t("content.close")}
        />
        <PaneSwitch
          panes={(["sources", "select", "result"] as const).map((value) => ({
            value,
            label: t(`folderEdit.pane.${value}`),
            count: paneCounts[value],
          }))}
          value={pane}
          onChange={setPane}
        />
        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[17rem_minmax(0,1fr)_minmax(0,25rem)]">
          <ResourceColumn
            workspace={workspace}
            active={pane === "sources"}
            onSelect={(resource) => {
              workspace.selectResource(resource);
              setPane("select");
            }}
          />
          <SelectionColumn workspace={workspace} active={pane === "select"} />
          <ResultColumn workspace={workspace} rootPath={target.rootPath} active={pane === "result"} />
        </div>
        <FolderEditFooter
          workspace={workspace}
          onBack={onBack}
          onReviewConflicts={() => setPane("result")}
          onApply={startApply}
        />
      </Dialog>
      {confirmation && (
        <ConfirmMediaBatchDeleteDialog
          targets={confirmation.targets}
          mode="files_only"
          step={confirmation.step}
          deleting={workspace.applying}
          onCancel={() => setConfirmation(null)}
          onContinue={() => setConfirmation({ ...confirmation, step: 2 })}
          onConfirm={() => {
            setConfirmation(null);
            void workspace.apply();
          }}
        />
      )}
    </>
  );
}

function ResourceColumn({
  workspace,
  active,
  onSelect,
}: {
  workspace: FolderEditWorkspace;
  active: boolean;
  onSelect: (resource: FolderEditResource) => void;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const canCheckRemote = !auth.demoMode && auth.hasPermission("remote:track");
  const checkingRemote = workspace.remoteCheck === "checking";
  const local = workspace.resources.filter((resource) => resource.kind !== "remote");
  const remote = workspace.resources.filter((resource) => resource.kind === "remote");
  const groups = [
    { key: "local", label: t("folderEdit.local"), items: local, empty: "" },
    { key: "remote", label: t("folderEdit.remote"), items: remote, empty: t("folderEdit.noRemoteSources") },
  ];
  return (
    <aside
      aria-label={t("folderEdit.pane.sources")}
      className={cn(
        "app-scroll min-h-0 flex-1 overflow-auto bg-muted/30 lg:block lg:flex-none lg:border-r",
        active ? "block" : "hidden",
      )}
    >
      {groups.map((group) => (
        <div key={group.key} className="px-3 py-3 lg:px-4" role="group" aria-label={group.label}>
          <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
            <ColumnLabel>{group.label}</ColumnLabel>
            {group.key === "remote" && canCheckRemote && (
              <Button
                variant="ghost"
                size="sm"
                className="-mr-2 h-6 gap-1 px-2 text-2xs"
                disabled={checkingRemote || workspace.sourcesStatus === "loading" || workspace.applying}
                onClick={workspace.checkRemote}
                title={t("folderEdit.checkRemoteHint")}
              >
                <RefreshCw className={cn("h-3 w-3", checkingRemote && "animate-spin")} />
                {checkingRemote ? t("folderEdit.checkingRemote") : t("folderEdit.checkRemote")}
              </Button>
            )}
          </div>
          <div className="space-y-1.5">
            {group.items.map((resource) => (
              <ResourceOption
                key={resource.id}
                icon={resource.kind === "remote" ? Cloud : resource.kind === "current" ? FolderOpen : HardDrive}
                title={resourceTitle(resource, t)}
                note={resource.kind !== "current" && resource.origin ? t("remoteFetch.origin") : undefined}
                code={resource.editionCode}
                detail={resource.kind === "remote" ? resource.sourceName : resource.rootPath}
                removes={resource.kind === "current"}
                selected={workspace.activeResource.id === resource.id}
                changes={folderEditResourceChanges(
                  resource,
                  workspace.files[resource.id]?.status === "ready" ? workspace.files[resource.id].files : undefined,
                  workspace.selection[resource.id],
                )}
                disabled={workspace.applying}
                onSelect={() => onSelect(resource)}
              />
            ))}
            {group.key === "remote" && workspace.sourcesStatus === "loading" && (
              <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("folderEdit.loadingSources")}
              </div>
            )}
            {group.key === "remote" && workspace.sourcesStatus === "error" && (
              <div className="space-y-1.5 px-1 text-xs text-muted-foreground" role="alert">
                <div>{t("folderEdit.sourcesFailed")}</div>
                <Button variant="outline" size="sm" onClick={workspace.retrySources}>
                  {t("folderEdit.retry")}
                </Button>
              </div>
            )}
            {group.items.length === 0 && group.empty && workspace.sourcesStatus === "ready" && (
              <div className="px-1 text-xs text-muted-foreground">{group.empty}</div>
            )}
          </div>
        </div>
      ))}
    </aside>
  );
}

function resourceTitle(resource: FolderEditResource, t: (key: string) => string) {
  if (resource.kind === "current") return t("folderEdit.currentFolder");
  return languageLabel(resource.language, t);
}

function SelectionColumn({ workspace, active }: { workspace: FolderEditWorkspace; active: boolean }) {
  const { t } = useTranslation();
  const resource = workspace.activeResource;
  const state = workspace.files[resource.id];
  const files = state?.status === "ready" ? state.files : noFiles;
  const selected = workspace.selection[resource.id] ?? noSelection;
  const tree = useMemo(() => buildFolderEditTree(files), [files]);
  const extensions = useMemo(() => folderEditExtensions(files).slice(0, 5), [files]);
  const allPaths = useMemo(() => files.map((file) => file.path), [files]);
  const selectedCount = files.filter((file) => selected.has(file.path)).length;
  const bytes = folderEditSelectedBytes(files, selected);
  const setIncluded = (paths: readonly string[], included: boolean) =>
    workspace.setSelected(resource.id, withFolderEditPaths(selected, paths, included));
  const hint =
    resource.kind === "current"
      ? t("folderEdit.currentHint")
      : resource.kind === "local"
        ? t("folderEdit.localHint")
        : t("folderEdit.remoteHint", { source: resource.sourceName });
  return (
    <section
      aria-label={t("folderEdit.pane.select")}
      className={cn("min-h-0 flex-1 flex-col bg-card lg:flex lg:border-r", active ? "flex" : "hidden")}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5 lg:px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {resourceTitle(resource, t)}
              {resource.kind !== "current" && (
                <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                  {resource.editionCode}
                </span>
              )}
            </div>
            <div className="truncate text-xs tabular-nums text-muted-foreground">
              {t("folderEdit.selectionSummary", { selected: selectedCount, total: files.length })}
              {selectedCount > 0 && bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
            </div>
          </div>
          <div className="-mr-2 flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={workspace.applying || files.length === 0}
              onClick={() => setIncluded(allPaths, true)}
            >
              {t("remoteFetch.all")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={workspace.applying || files.length === 0}
              onClick={() => setIncluded(allPaths, false)}
            >
              {t("remoteFetch.none")}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {extensions.length > 1 && (
          <div role="group" aria-label={t("remoteFetch.fileTypes")} className="flex flex-wrap items-center gap-1.5">
            {extensions.map(({ extension, paths }) => {
              const count = paths.filter((path) => selected.has(path)).length;
              const checked = count === paths.length;
              return (
                <label
                  key={extension}
                  className={cn(
                    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border pl-1.5 pr-2.5 text-xs transition-colors",
                    count > 0
                      ? "border-primary/40 bg-primary/[0.07]"
                      : "bg-background text-muted-foreground hover:bg-muted",
                  )}
                >
                  <Checkbox
                    className="h-4 w-4 rounded-full"
                    checked={checked}
                    indeterminate={count > 0 && !checked}
                    disabled={workspace.applying}
                    onCheckedChange={() => setIncluded(paths, !checked)}
                    aria-label={t("remoteFetch.include", { extension: extension.toUpperCase() })}
                  />
                  <span className="font-medium">{extension.toUpperCase()}</span>
                  <span className="tabular-nums text-muted-foreground">{paths.length}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
        {!state || state.status === "loading" ? (
          <PaneNote>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("folderEdit.loadingFiles")}
          </PaneNote>
        ) : state.status === "error" ? (
          <PaneNote>
            {t("folderEdit.filesFailed")}
            <Button variant="outline" size="sm" onClick={() => workspace.retryResource(resource)}>
              {t("folderEdit.retry")}
            </Button>
          </PaneNote>
        ) : files.length === 0 ? (
          <PaneNote>{t("folderEdit.noFiles")}</PaneNote>
        ) : (
          <SelectionNode
            // Folder open state belongs to the resource it was opened in.
            key={resource.id}
            node={tree}
            depth={0}
            selected={selected}
            disabled={workspace.applying}
            onToggle={setIncluded}
            isRoot
          />
        )}
      </div>
    </section>
  );
}

const noFiles: FolderEditFile[] = [];

function ResultColumn({
  workspace,
  rootPath,
  active,
}: {
  workspace: FolderEditWorkspace;
  rootPath: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildFolderEditTree(workspace.result), [workspace.result]);
  const added = workspace.result.filter((entry) => entry.state === "add_local" || entry.state === "add_remote").length;
  const removed = workspace.result.filter((entry) => entry.state === "remove").length;
  return (
    <section
      aria-label={t("folderEdit.pane.result")}
      className={cn("min-h-0 flex-1 flex-col bg-card lg:flex", active ? "flex" : "hidden")}
    >
      <div className="shrink-0 space-y-1 border-b px-3 py-2.5 lg:px-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">{t("folderEdit.pane.result")}</div>
          <div className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
            {added > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 py-px font-medium text-primary">
                {t("folderEdit.addCount", { count: added })}
              </span>
            )}
            {removed > 0 && (
              <span className="rounded-full bg-error-surface px-1.5 py-px font-medium text-error-foreground">
                {t("folderEdit.removeCount", { count: removed })}
              </span>
            )}
          </div>
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground" title={rootPath}>
          {rootPath}
        </div>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
        {workspace.result.length === 0 ? (
          <PaneNote>{t("folderEdit.emptyResult")}</PaneNote>
        ) : (
          <ResultNode
            node={tree}
            depth={0}
            decisions={workspace.decisions}
            disabled={workspace.applying}
            onDecisionChange={workspace.setDecision}
            isRoot
          />
        )}
      </div>
    </section>
  );
}

function FolderEditFooter({
  workspace,
  onBack,
  onReviewConflicts,
  onApply,
}: {
  workspace: FolderEditWorkspace;
  onBack?: () => void;
  onReviewConflicts: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const { readiness, plan, request } = workspace;
  const add = plan?.summary.add ?? 0;
  const remove = request.removeLocationIds.length;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t bg-muted/35 px-3 py-2.5 sm:px-5">
      <div
        aria-live="polite"
        className="flex min-h-8 min-w-0 basis-full items-center gap-2 text-sm sm:basis-0 sm:flex-1"
      >
        {workspace.planFailed ? (
          <>
            <AlertTriangle className="h-4 w-4 shrink-0 text-error" />
            <span className="truncate text-error-foreground">{t("folderEdit.planFailed")}</span>
            <Button variant="ghost" size="sm" className="shrink-0 px-2" onClick={workspace.retryPlan}>
              {t("folderEdit.retry")}
            </Button>
          </>
        ) : readiness === "refreshing" || workspace.applying ? (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <span className="truncate text-muted-foreground">
              {workspace.applying ? t("folderEdit.applying") : t("remoteFetch.refreshingPreview")}
            </span>
          </>
        ) : readiness === "blocked" ? (
          <>
            <AlertTriangle className="h-4 w-4 shrink-0 text-error" />
            <span className="truncate text-error-foreground">
              {t("folderEdit.statusBlocked", { count: plan?.summary.conflict ?? 0 })}
            </span>
            <Button variant="ghost" size="sm" className="shrink-0 px-2 lg:hidden" onClick={onReviewConflicts}>
              {t("remoteFetch.review")}
            </Button>
          </>
        ) : readiness === "ready" ? (
          <>
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            <span className="truncate">{t("folderEdit.statusReady", { add, remove })}</span>
          </>
        ) : (
          <span className="truncate text-muted-foreground">{t("folderEdit.statusIdle")}</span>
        )}
      </div>
      <div className="ml-auto flex gap-2">
        {onBack && (
          <Button variant="outline" onClick={onBack} disabled={workspace.applying}>
            <ArrowLeft className="h-4 w-4" />
            {t("folderEdit.back")}
          </Button>
        )}
        <Button onClick={onApply} disabled={readiness !== "ready" || workspace.applying || workspace.planFailed}>
          <CheckCircle2 className="h-4 w-4" />
          {t("folderEdit.apply")}
        </Button>
      </div>
    </div>
  );
}

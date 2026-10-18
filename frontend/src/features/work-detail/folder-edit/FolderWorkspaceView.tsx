import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import {
  buildFolderEditTree,
  folderEditExtensions,
  folderEditResourceChanges,
  folderEditSelectedBytes,
  withFolderEditPaths,
  type FolderEditFile,
  type FolderEditResource,
} from "@/features/work-detail/folder-edit/folderEditModel";
import type { FolderWorkspace } from "@/features/work-detail/folder-edit/folderWorkspace";
import {
  ColumnLabel,
  PaneNote,
  PaneSwitch,
  ResourceOption,
  ResultNode,
  SelectionNode,
} from "@/features/work-detail/folder-edit/FolderEditPanes";
import { isLyricsFilePath } from "@/features/work-detail/lyrics/remoteLyricsModel";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { languageLabel } from "@/features/work-detail/workflows/RemoteFetchWorkspaceTrees";
import { lyricsLanguages, lyricsRootFolderName } from "@/lib/lyricsLanguage";
import { cn } from "@/lib/tailwindClassNames";

type EditPane = "sources" | "select" | "result";

const noSelection: ReadonlySet<string> = new Set();
const noFiles: FolderEditFile[] = [];
/** The role select's value for a file added at its own path. */
const AS_FILE = "file";

/**
 * Builds one folder in three columns: where files can come from, the files of
 * the chosen place with the role each takes, and the folder as it will be.
 */
export function FolderWorkspaceView({
  workspace,
  title,
  description,
  icon,
  marker,
  hints,
  notice,
  emptyResult,
  statusIdle,
  statusReady,
  applyingLabel,
  applyLabel,
  initialPane = "sources",
  onBack,
  onClose,
  onApply,
}: {
  workspace: FolderWorkspace;
  title: string;
  description: string;
  icon: ReactNode;
  marker: string;
  /** What selecting a file of each kind of place does. */
  hints: (resource: FolderEditResource) => string;
  /** Shown above the final folder, such as a folder that needs review. */
  notice?: ReactNode;
  emptyResult: string;
  statusIdle: string;
  statusReady: string;
  applyingLabel: string;
  applyLabel: string;
  initialPane?: EditPane;
  onBack?: () => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const [pane, setPane] = useState<EditPane>(initialPane);
  const paneCounts: Record<EditPane, number> = {
    sources: workspace.resources.length,
    select: workspace.additionCount,
    result: workspace.result.filter((entry) => entry.state !== "remove" && entry.state !== "excluded").length,
  };
  return (
    <Dialog
      onClose={onClose}
      size="full"
      dismissible={!workspace.applying}
      marker={marker}
      className="h-[var(--dialog-max-height)] max-w-7xl bg-background md:h-[min(90dvh,var(--dialog-max-height))]"
    >
      <DialogHeader
        title={title}
        description={description}
        icon={icon}
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
        <SelectionColumn workspace={workspace} hint={hints(workspace.activeResource)} active={pane === "select"} />
        <ResultColumn workspace={workspace} notice={notice} emptyResult={emptyResult} active={pane === "result"} />
      </div>
      <WorkspaceFooter
        workspace={workspace}
        statusIdle={statusIdle}
        statusReady={statusReady}
        applyingLabel={applyingLabel}
        applyLabel={applyLabel}
        onBack={onBack}
        onReviewConflicts={() => setPane("result")}
        onApply={onApply}
      />
    </Dialog>
  );
}

function resourceIcon(resource: FolderEditResource): LucideIcon {
  if (resource.kind === "remote") return Cloud;
  return resource.kind === "current" ? FolderOpen : HardDrive;
}

function ResourceColumn({
  workspace,
  active,
  onSelect,
}: {
  workspace: FolderWorkspace;
  active: boolean;
  onSelect: (resource: FolderEditResource) => void;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const canCheckRemote = Boolean(workspace.remoteCheck) && !auth.demoMode && auth.hasPermission("remote:track");
  const checkingRemote = workspace.remoteCheck?.checking ?? false;
  const local = workspace.resources.filter((resource) => resource.kind !== "remote");
  const remote = workspace.resources.filter((resource) => resource.kind === "remote");
  const groups = [
    { key: "remote", label: t("folderEdit.remote"), items: remote, empty: t("folderEdit.noRemoteSources") },
    { key: "local", label: t("folderEdit.local"), items: local, empty: "" },
  ].filter((group) => !(workspace.localOnly && group.key === "remote"));
  // The place list loads with the remote sources; without them its state shows under local places.
  const statusGroup = workspace.localOnly ? "local" : "remote";
  // An edit lists its own folder first; a Fetch lists the edition it fetches first.
  if (local[0]?.kind === "current") groups.reverse();
  return (
    <aside
      aria-label={t("folderEdit.pane.sources")}
      className={cn(
        "app-scroll min-h-0 flex-1 overflow-auto bg-muted/30 lg:block lg:flex-none lg:border-r",
        active ? "block" : "hidden",
      )}
    >
      {groups.map((group) =>
        group.items.length === 0 && !group.empty ? null : (
          <div key={group.key} className="px-3 py-3 lg:px-4" role="group" aria-label={group.label}>
            <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
              <ColumnLabel>{group.label}</ColumnLabel>
              {group.key === "remote" && canCheckRemote && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mr-2 h-6 gap-1 px-2 text-2xs"
                  disabled={checkingRemote || workspace.sourcesStatus === "loading" || workspace.applying}
                  onClick={workspace.remoteCheck?.check}
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
                  icon={resourceIcon(resource)}
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
              {group.key === statusGroup && workspace.sourcesStatus === "loading" && (
                <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground" role="status">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("folderEdit.loadingSources")}
                </div>
              )}
              {group.key === statusGroup && workspace.sourcesStatus === "error" && (
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
        ),
      )}
    </aside>
  );
}

function resourceTitle(resource: FolderEditResource, t: (key: string) => string) {
  if (resource.kind === "current") return t("folderEdit.currentFolder");
  return languageLabel(resource.language, t);
}

/** The role a file takes: a file at its own path, or lyrics of a language. */
function LyricsRoleSelect({
  value,
  label,
  mixed = false,
  compact = false,
  disabled,
  onChange,
}: {
  value: string | undefined;
  label: string;
  mixed?: boolean;
  /** Sits on a line of its own under a file name. */
  compact?: boolean;
  disabled: boolean;
  onChange: (language: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      className={cn(
        "h-7 shrink-0 rounded-md border bg-background px-1.5 text-xs",
        compact ? "h-6 max-w-full text-2xs" : "max-w-48",
      )}
      aria-label={label}
      value={mixed ? "" : (value ?? AS_FILE)}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === AS_FILE ? null : event.target.value)}
    >
      {mixed && (
        <option value="" disabled>
          {t("folderEdit.roleMixed")}
        </option>
      )}
      <option value={AS_FILE}>{t("folderEdit.asFile")}</option>
      {lyricsLanguages.map(([language, labelKey]) => (
        <option key={language || "fallback"} value={language}>
          {t("folderEdit.asLyrics", { language: t(labelKey) })}
        </option>
      ))}
    </select>
  );
}

function SelectionColumn({ workspace, hint, active }: { workspace: FolderWorkspace; hint: string; active: boolean }) {
  const { t } = useTranslation();
  const resource = workspace.activeResource;
  const state = workspace.files[resource.id];
  const files = state?.status === "ready" ? state.files : noFiles;
  const selected = workspace.selection[resource.id] ?? noSelection;
  const roles = workspace.lyrics[resource.id];
  const tree = useMemo(() => buildFolderEditTree(files), [files]);
  const extensions = useMemo(() => folderEditExtensions(files).slice(0, 5), [files]);
  const allPaths = useMemo(() => files.map((file) => file.path), [files]);
  // The edited folder's own files keep their place; any other place's lyrics can become managed lyrics.
  const lyricsPaths = useMemo(
    () =>
      resource.kind === "current" ? [] : files.filter((file) => isLyricsFilePath(file.path)).map((file) => file.path),
    [files, resource.kind],
  );
  const selectedLyrics = lyricsPaths.filter((path) => selected.has(path));
  const selectedRoles = new Set(selectedLyrics.map((path) => roles?.[path] ?? AS_FILE));
  const selectedCount = files.filter((file) => selected.has(file.path)).length;
  const bytes = folderEditSelectedBytes(files, selected);
  const setIncluded = (paths: readonly string[], included: boolean) =>
    workspace.setSelected(resource.id, withFolderEditPaths(selected, paths, included));
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
        {lyricsPaths.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("folderEdit.selectedLyricsRole")}</span>
            <LyricsRoleSelect
              value={selectedRoles.size === 1 ? [...selectedRoles][0] : undefined}
              mixed={selectedRoles.size > 1}
              label={t("folderEdit.selectedLyricsRole")}
              disabled={workspace.applying || selectedLyrics.length === 0}
              onChange={(language) => workspace.setLyricsRole(resource.id, selectedLyrics, language)}
            />
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
            below={
              lyricsPaths.length > 0
                ? (file) =>
                    isLyricsFilePath(file.path) ? (
                      <LyricsRoleSelect
                        value={roles?.[file.path]}
                        compact
                        label={t("folderEdit.fileRole", { name: file.name })}
                        disabled={workspace.applying}
                        onChange={(language) => workspace.setLyricsRole(resource.id, [file.path], language)}
                      />
                    ) : null
                : undefined
            }
            isRoot
          />
        )}
      </div>
    </section>
  );
}

function ResultColumn({
  workspace,
  notice,
  emptyResult,
  active,
}: {
  workspace: FolderWorkspace;
  notice?: ReactNode;
  emptyResult: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildFolderEditTree(workspace.result), [workspace.result]);
  const added = workspace.result.filter((entry) => entry.state === "add_local" || entry.state === "add_remote").length;
  const removed = workspace.result.filter((entry) => entry.state === "remove").length;
  const showAssign = workspace.canAssign && workspace.lyricsAdditionCount > 0;
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
        <div className="truncate font-mono text-xs text-muted-foreground" title={workspace.rootPath}>
          {workspace.rootPath || t("fetchCompose.newFolder")}
        </div>
        {workspace.lyricsAdditionCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("folderEdit.lyricsTarget", { folder: lyricsRootFolderName })}
          </p>
        )}
        {showAssign && (
          <label className="flex items-start gap-2 pt-1 text-xs" title={t("folderEdit.assignHint")}>
            <Checkbox
              checked={workspace.assign}
              disabled={workspace.applying}
              onCheckedChange={(checked) => workspace.setAssign(checked)}
            />
            <span>
              {t("folderEdit.assign")}
              {workspace.assign && workspace.assignmentCount > 0 && (
                <span className="ml-1 tabular-nums">({workspace.assignmentCount})</span>
              )}
            </span>
          </label>
        )}
        {notice}
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
        {workspace.result.length === 0 ? (
          <PaneNote>{emptyResult}</PaneNote>
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

function WorkspaceFooter({
  workspace,
  statusIdle,
  statusReady,
  applyingLabel,
  applyLabel,
  onBack,
  onReviewConflicts,
  onApply,
}: {
  workspace: FolderWorkspace;
  statusIdle: string;
  statusReady: string;
  applyingLabel: string;
  applyLabel: string;
  onBack?: () => void;
  onReviewConflicts: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const { readiness } = workspace;
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
              {workspace.applying ? applyingLabel : t("remoteFetch.refreshingPreview")}
            </span>
          </>
        ) : readiness === "blocked" ? (
          <>
            <AlertTriangle className="h-4 w-4 shrink-0 text-error" />
            <span className="truncate text-error-foreground">
              {t("folderEdit.statusBlocked", { count: workspace.conflictCount })}
            </span>
            <Button variant="ghost" size="sm" className="shrink-0 px-2 lg:hidden" onClick={onReviewConflicts}>
              {t("remoteFetch.review")}
            </Button>
          </>
        ) : readiness === "ready" ? (
          <>
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            <span className="truncate">{statusReady}</span>
          </>
        ) : (
          <span className="truncate text-muted-foreground">{statusIdle}</span>
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
          {applyLabel}
        </Button>
      </div>
    </div>
  );
}

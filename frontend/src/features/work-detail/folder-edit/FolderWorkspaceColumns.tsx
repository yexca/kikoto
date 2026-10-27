import {
  ChevronDown,
  Copy,
  Download,
  FolderInput,
  FolderPlus,
  ListChecks,
  Loader2,
  Merge,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { fileWorkspacePlace, finalFolderPaths } from "@/features/work-detail/folder-edit/fileWorkspaceModel";
import {
  FolderEditArrangeTree,
  RowMenu,
  startFolderEditDrag,
  type FolderEditDrop,
} from "@/features/work-detail/folder-edit/FolderEditArrangeTree";
import {
  buildFolderEditTree,
  currentFileKey,
  folderEditCanMerge,
  folderEditExtensions,
  folderEditResourceChanges,
  folderEditSelectedBytes,
  withFolderEditPaths,
  type FolderEditFile,
  type FolderEditResource,
  type FolderEditResultEntry,
} from "@/features/work-detail/folder-edit/folderEditModel";
import type { FolderWorkspace, FolderWorkspaceManage } from "@/features/work-detail/folder-edit/folderWorkspace";
import {
  ColumnLabel,
  PaneNote,
  ResourceOption,
  ResultNode,
  SelectionNode,
} from "@/features/work-detail/folder-edit/FolderEditPanes";
import { PlaceBadge, placeIcon, placeReason, placeTone } from "@/features/work-detail/folder-edit/FolderWorkspaceTools";
import { PendingDeletionPanel } from "@/features/work-detail/folder-edit/PendingDeletionPanel";
import { isLyricsFilePath } from "@/features/work-detail/lyrics/remoteLyricsModel";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { languageLabel } from "@/features/work-detail/workflows/RemoteFetchWorkspaceTrees";
import { lyricsLanguages, lyricsRootFolderName } from "@/lib/lyricsLanguage";
import { cn } from "@/lib/tailwindClassNames";

const noSelection: ReadonlySet<string> = new Set();
const noFiles: FolderEditFile[] = [];
/** The role select's value for a file added at its own path. */
const AS_FILE = "file";

export function resourceTitle(resource: FolderEditResource, t: (key: string) => string) {
  if (resource.kind === "current") return t("folderEdit.currentFolder");
  return languageLabel(resource.language, t);
}

/** The places files can come from, grouped into local and remote, with the edited folder first. */
export function ResourceColumn({
  workspace,
  active,
  onSelect,
}: {
  workspace: FolderWorkspace;
  active: boolean;
  onSelect: (resource: FolderEditResource) => void;
}) {
  const { t } = useTranslation();
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
              {group.key === "remote" && <CheckSourcesButton workspace={workspace} className="-mr-2" />}
            </div>
            <div className="space-y-1.5">
              {group.items.map((resource) => (
                <ResourceOption
                  key={resource.id}
                  icon={placeIcon(fileWorkspacePlace(resource))}
                  stripe={placeTone[fileWorkspacePlace(resource)].band}
                  title={resourceTitle(resource, t)}
                  noteTone={resource.offline ? "warning" : "muted"}
                  note={resourceNote(workspace, resource, t)}
                  code={resource.editionCode}
                  detail={resource.kind === "remote" ? resource.sourceName : resource.rootPath}
                  removes={resource.kind === "current"}
                  selected={workspace.activeResource.id === resource.id}
                  changes={folderEditResourceChanges(
                    resource,
                    workspace.files[resource.id]?.status === "ready" ? workspace.files[resource.id].files : undefined,
                    workspace.selection[resource.id],
                  )}
                  disabled={workspace.applying || Boolean(resource.offline)}
                  onSelect={() => onSelect(resource)}
                />
              ))}
              {group.key === statusGroup && <SourcesStatus workspace={workspace} />}
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

/** A short remark on a place: offline, merged into the edited folder, or the work's origin edition. */
export function resourceNote(
  workspace: FolderWorkspace,
  resource: FolderEditResource,
  t: (key: string) => string,
): string | undefined {
  if (resource.offline) return t("libraryOffline.badge");
  if (resource.kind === "local" && workspace.merge?.folderIds.has(resource.folderId)) return t("folderEdit.mergeBadge");
  return resource.kind !== "current" && resource.origin ? t("remoteFetch.origin") : undefined;
}

/**
 * What the edit does with another local folder, in the place its Copy only
 * mark would take: Copy takes the files you choose and leaves the folder, and
 * Merge takes all of them and then deletes the folder. Merge turns on once
 * the folder's files have loaded, so that it takes all of them.
 */
export function CopyMergeSwitch({ workspace, resource }: { workspace: FolderWorkspace; resource: FolderEditResource }) {
  const { t } = useTranslation();
  const merge = workspace.merge;
  if (!merge || resource.kind !== "local") return null;
  const merging = merge.folderIds.has(resource.folderId);
  const canMerge = merging || folderEditCanMerge(resource, workspace.files[resource.id]);
  const modes = [
    { value: "copy", merges: false, icon: Copy, label: t("fileWorkspace.mode.copy") },
    { value: "merge", merges: true, icon: Merge, label: t("fileWorkspace.mode.merge") },
  ] as const;
  return (
    <div
      role="radiogroup"
      aria-label={t("fileWorkspace.mode.label", { folder: resource.rootPath })}
      className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full border bg-background p-0.5 text-2xs font-medium"
    >
      {modes.map(({ value, merges, icon: Icon, label }) => {
        const on = merging === merges;
        const waiting = merges && !canMerge;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={workspace.applying || waiting}
            title={waiting ? t("fileWorkspace.mode.mergeWait") : undefined}
            onClick={() => {
              if (!on) merge.setMerged(resource, merges);
            }}
            className={cn(
              "touch-target inline-flex h-6 items-center gap-1 rounded-full px-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              on
                ? merges
                  ? "bg-destructive text-destructive-foreground"
                  : cn(placeTone.local.surface, placeTone.local.text)
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Asks every remote source again about each edition of the work, for users who may check sources. */
export function CheckSourcesButton({ workspace, className }: { workspace: FolderWorkspace; className?: string }) {
  const { t } = useTranslation();
  const auth = useAuth();
  if (!workspace.remoteCheck || auth.demoMode || !auth.hasPermission("remote:track")) return null;
  const checking = workspace.remoteCheck.checking;
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("h-6 gap-1 px-2 text-2xs", className)}
      disabled={checking || workspace.sourcesStatus === "loading" || workspace.applying}
      onClick={workspace.remoteCheck.check}
      title={t("folderEdit.checkRemoteHint")}
    >
      <RefreshCw className={cn("h-3 w-3", checking && "animate-spin")} />
      {checking ? t("folderEdit.checkingRemote") : t("folderEdit.checkRemote")}
    </Button>
  );
}

/** Whether the list of places is still loading or failed to load. */
export function SourcesStatus({ workspace }: { workspace: FolderWorkspace }) {
  const { t } = useTranslation();
  if (workspace.sourcesStatus === "loading") {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("folderEdit.loadingSources")}
      </div>
    );
  }
  if (workspace.sourcesStatus === "error") {
    return (
      <div className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground" role="alert">
        <span>{t("folderEdit.sourcesFailed")}</span>
        <Button variant="outline" size="sm" onClick={workspace.retrySources}>
          {t("folderEdit.retry")}
        </Button>
      </div>
    );
  }
  return null;
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

/** Selects a place's files by format; for the edited folder, a selected file is a kept one. */
export function ExtensionChips({
  files,
  selected,
  disabled,
  label,
  onToggle,
}: {
  files: readonly FolderEditFile[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  label?: string;
  onToggle: (paths: readonly string[], included: boolean) => void;
}) {
  const { t } = useTranslation();
  const extensions = useMemo(() => folderEditExtensions(files).slice(0, 5), [files]);
  if (extensions.length < 2) return null;
  return (
    <div role="group" aria-label={label ?? t("remoteFetch.fileTypes")} className="flex flex-wrap items-center gap-1.5">
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      {extensions.map(({ extension, paths }) => {
        const count = paths.filter((path) => selected.has(path)).length;
        const checked = count === paths.length;
        return (
          <label
            key={extension}
            className={cn(
              "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border pl-1.5 pr-2.5 text-xs transition-colors",
              count > 0 ? "border-primary/40 bg-primary/[0.07]" : "bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            <Checkbox
              className="h-4 w-4 rounded-full"
              checked={checked}
              indeterminate={count > 0 && !checked}
              disabled={disabled}
              onCheckedChange={() => onToggle(paths, !checked)}
              aria-label={t("remoteFetch.include", { extension: extension.toUpperCase() })}
            />
            <span className="font-medium">{extension.toUpperCase()}</span>
            <span className="tabular-nums text-muted-foreground">{paths.length}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * The files of one place with the role each takes. For the edited folder a
 * selected file is kept; for any other place a selected file is added. With
 * `header`, the column leads with it, such as a wide pane's place picker.
 */
export function SelectionColumn({
  workspace,
  resource,
  hint,
  active,
  manage,
  header,
  className,
}: {
  workspace: FolderWorkspace;
  resource: FolderEditResource;
  hint: string;
  active: boolean;
  manage?: FolderWorkspaceManage;
  header?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const state = workspace.files[resource.id];
  const files = state?.status === "ready" ? state.files : noFiles;
  const selected = workspace.selection[resource.id] ?? noSelection;
  const roles = workspace.lyrics[resource.id];
  const tree = useMemo(() => buildFolderEditTree(files), [files]);
  const allPaths = useMemo(() => files.map((file) => file.path), [files]);
  const current = resource.kind === "current";
  const place = fileWorkspacePlace(resource);
  // The edited folder's own files keep their place; any other place's lyrics can become managed lyrics.
  const lyricsPaths = useMemo(
    () => (current ? [] : files.filter((file) => isLyricsFilePath(file.path)).map((file) => file.path)),
    [current, files],
  );
  const selectedLyrics = lyricsPaths.filter((path) => selected.has(path));
  const selectedRoles = new Set(selectedLyrics.map((path) => roles?.[path] ?? AS_FILE));
  const selectedCount = files.filter((file) => selected.has(file.path)).length;
  const bytes = folderEditSelectedBytes(files, selected);
  const setIncluded = (paths: readonly string[], included: boolean) =>
    workspace.setSelected(resource.id, withFolderEditPaths(selected, paths, included));
  const merging = resource.kind === "local" && Boolean(workspace.merge?.folderIds.has(resource.folderId));
  const [toolsOpen, setToolsOpen] = useState(false);
  const arrange = workspace.arrange;
  const finalFolders = useMemo(
    () => (arrange ? finalFolderPaths(workspace.result, arrange.folders) : []),
    [arrange, workspace.result],
  );
  // Dragging a file or folder to the final folder adds it there; this list does not change.
  const onDragFiles =
    arrange && !current
      ? (event: DragEvent, paths: readonly string[], base: string) =>
          startFolderEditDrag(
            event,
            { kind: "source", resource, paths, base },
            paths.length === 1 ? (paths[0].split("/").pop() ?? paths[0]) : `${paths.length}`,
          )
      : undefined;
  // The same as a drag, for touch and keyboard: copy a file or folder to a folder of the final folder.
  const copyLabel = resource.kind === "remote" ? t("fileWorkspace.downloadTo") : t("fileWorkspace.copyTo");
  const rowMenu =
    arrange && !current
      ? (paths: readonly string[], base: string, name: string) => (
          <RowMenu
            label={t("folderEdit.fileActions", { name })}
            actions={[
              {
                key: "copy",
                label: copyLabel,
                icon: resource.kind === "remote" ? Download : FolderInput,
                choosesFolder: true,
                run: () => undefined,
              },
            ]}
            chooserLabel={copyLabel}
            note={placeReason(place, t)}
            moveTargets={["", ...finalFolders]}
            disabled={workspace.applying}
            onMove={(folder) => arrange.placeFromResource(resource, paths, base, folder)}
          />
        )
      : undefined;
  const below =
    current && manage?.fileNote
      ? (file: FolderEditFile) => manage.fileNote?.(file.path)
      : lyricsPaths.length > 0
        ? (file: FolderEditFile) =>
            isLyricsFilePath(file.path) ? (
              <LyricsRoleSelect
                value={roles?.[file.path]}
                compact
                label={t("folderEdit.fileRole", { name: file.name })}
                disabled={workspace.applying}
                onChange={(language) => workspace.setLyricsRole(resource.id, [file.path], language)}
              />
            ) : null
        : undefined;
  return (
    <section
      aria-label={header ? resourceTitle(resource, t) : t("folderEdit.pane.select")}
      className={cn(
        "min-h-0 flex-1 flex-col bg-card",
        header ? "flex" : cn("lg:flex lg:border-r", active ? "flex" : "hidden"),
        className,
      )}
    >
      {header}
      <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5 lg:px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {!header && (
              <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <span className="truncate">{resourceTitle(resource, t)}</span>
                {!current && (
                  <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">
                    {resource.editionCode}
                  </span>
                )}
                {resource.kind === "local" && workspace.merge ? (
                  <CopyMergeSwitch workspace={workspace} resource={resource} />
                ) : (
                  manage && <PlaceBadge place={place} />
                )}
              </div>
            )}
            <div className="truncate text-xs tabular-nums text-muted-foreground">
              {t(current ? "fileWorkspace.keptSummary" : "folderEdit.selectionSummary", {
                selected: selectedCount,
                total: files.length,
              })}
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
              {current && manage ? t("fileWorkspace.keepAll") : t("remoteFetch.all")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={workspace.applying || files.length === 0}
              onClick={() => setIncluded(allPaths, false)}
            >
              {current && manage ? t("fileWorkspace.deleteAll") : t("remoteFetch.none")}
            </Button>
          </div>
        </div>
        {merging ? (
          // Merging deletes the whole folder, so it says so where the files are chosen.
          <p className="flex gap-2 rounded-md border border-error-border bg-error-surface px-3 py-2 text-xs text-error-foreground">
            <Trash2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("fileWorkspace.mergeNote")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
        {current && manage ? (
          // The edited folder's tools fold away, so its files keep the room on a phone.
          <>
            <Button
              variant="toolbar"
              size="sm"
              className="self-start"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((open) => !open)}
            >
              <ListChecks className="h-4 w-4" aria-hidden="true" />
              {t("libraryDetail.quickSelect")}
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", toolsOpen && "rotate-180")}
                aria-hidden="true"
              />
            </Button>
            {toolsOpen && (
              <div className="space-y-2" role="group" aria-label={t("libraryDetail.quickSelect")}>
                <ExtensionChips
                  files={files}
                  selected={selected}
                  disabled={workspace.applying}
                  label={t("fileWorkspace.keepByFormat")}
                  onToggle={setIncluded}
                />
                {manage.thisFolderTools}
              </div>
            )}
          </>
        ) : (
          <ExtensionChips files={files} selected={selected} disabled={workspace.applying} onToggle={setIncluded} />
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
            onDragFiles={onDragFiles}
            below={below}
            folderNote={current ? manage?.folderNote : undefined}
            rowMenu={rowMenu}
            isRoot
          />
        )}
      </div>
    </section>
  );
}

/**
 * The folder as it will be, arranged like a file manager. With `manage`, it
 * also has a view of everything the edit deletes, and with `header` it is a
 * wide pane that leaves the files it deletes to that view.
 */
export function ResultColumn({
  workspace,
  notice,
  emptyResult,
  active,
  manage,
  view = "folder",
  onViewChange,
  header,
  tools,
  className,
}: {
  workspace: FolderWorkspace;
  notice?: ReactNode;
  emptyResult: string;
  active: boolean;
  manage?: FolderWorkspaceManage;
  view?: "folder" | "delete";
  onViewChange?: (view: "folder" | "delete") => void;
  header?: ReactNode;
  /** Shown above the tree, such as the edited folder's own tools in a wide pane. */
  tools?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const entries = useMemo(
    () => (header ? workspace.result.filter((entry) => entry.state !== "remove") : workspace.result),
    [header, workspace.result],
  );
  const tree = useMemo(() => buildFolderEditTree(entries), [entries]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [dropped, setDropped] = useState<FolderEditDrop | null>(null);
  // What the last drop did stays in view for a moment, then gives way to the folder.
  useEffect(() => {
    if (!dropped) return;
    const timer = window.setTimeout(() => setDropped(null), 5000);
    return () => window.clearTimeout(timer);
  }, [dropped]);
  const added = workspace.result.filter((entry) => entry.state === "add_local" || entry.state === "add_remote").length;
  const removed = workspace.result.filter((entry) => entry.state === "remove").length;
  const moved = workspace.result.filter((entry) => entry.state === "add_move").length;
  const showAssign = workspace.canAssign && workspace.lyricsAdditionCount > 0;
  const showingPending = Boolean(manage) && view === "delete" && !header;
  // A file the edited folder keeps carries its note, such as where it has an identical copy.
  const fileNote = manage?.fileNote;
  const ownPrefix = currentFileKey("");
  const entryNote = fileNote
    ? (entry: FolderEditResultEntry) =>
        entry.key.startsWith(ownPrefix) ? fileNote(entry.key.slice(ownPrefix.length)) : null
    : undefined;
  return (
    <section
      aria-label={header ? t("folderEdit.currentFolder") : t("folderEdit.pane.result")}
      className={cn(
        "min-h-0 flex-1 flex-col bg-card",
        header ? "flex" : cn("lg:flex", active ? "flex" : "hidden"),
        className,
      )}
    >
      {header}
      {manage && !header && (
        <div className="hidden shrink-0 gap-1 border-b px-3 pt-2 lg:flex" role="tablist">
          {(["folder", "delete"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              onClick={() => onViewChange?.(value)}
              className={cn(
                "-mb-px inline-flex min-h-9 items-center gap-1.5 border-b-2 px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === value
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {value === "folder" ? t("folderEdit.pane.result") : t("fileWorkspace.pending.short")}
              {value === "delete" && manage.pending.files > 0 && (
                <span className="rounded-full bg-error-surface px-1.5 text-2xs tabular-nums text-error-foreground">
                  {manage.pending.files}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {showingPending && manage ? (
        <PendingDeletionPanel pending={manage.pending} disabled={workspace.applying} onKeep={manage.onKeep} />
      ) : (
        <>
          <div className="shrink-0 space-y-1 border-b px-3 py-2.5 lg:px-4">
            <div className="flex items-center justify-between gap-2">
              {!header && <div className="text-sm font-medium">{t("folderEdit.pane.result")}</div>}
              <div className={cn("flex shrink-0 items-center gap-1.5 text-xs tabular-nums", header && "flex-1")}>
                {added > 0 && (
                  <span className="rounded-full bg-primary/10 px-1.5 py-px font-medium text-primary">
                    {t("folderEdit.addCount", { count: added })}
                  </span>
                )}
                {moved > 0 && (
                  <span className="rounded-full bg-muted px-1.5 py-px font-medium">
                    {t("folderEdit.moveCount", { count: moved })}
                  </span>
                )}
                {removed > 0 && (
                  <span className="rounded-full bg-error-surface px-1.5 py-px font-medium text-error-foreground">
                    {t("folderEdit.removeCount", { count: removed })}
                  </span>
                )}
                {workspace.arrange && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-mr-2 ml-auto h-7 gap-1 px-2 text-xs"
                    disabled={workspace.applying}
                    onClick={() => setCreatingFolder(true)}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    {t("folderEdit.newFolder")}
                  </Button>
                )}
              </div>
            </div>
            {!header && (
              <div className="truncate font-mono text-xs text-muted-foreground" title={workspace.rootPath}>
                {workspace.rootPath || t("fetchCompose.newFolder")}
              </div>
            )}
            {tools}
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
            {dropped && (
              <p className="text-xs text-muted-foreground" role="status">
                {t(`fileWorkspace.dropped.${dropped.action}`, {
                  count: dropped.count,
                  folder: dropped.folder || t("folderEdit.rootFolder"),
                })}
              </p>
            )}
            {notice}
          </div>
          <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
            {workspace.arrange ? (
              <>
                {entries.length === 0 && workspace.arrange.folders.length === 0 && !creatingFolder && (
                  <PaneNote>{emptyResult}</PaneNote>
                )}
                <FolderEditArrangeTree
                  entries={entries}
                  arrange={workspace.arrange}
                  decisions={workspace.decisions}
                  disabled={workspace.applying}
                  onDecisionChange={workspace.setDecision}
                  creatingAtRoot={creatingFolder}
                  onCreatedAtRoot={() => setCreatingFolder(false)}
                  onDiscard={manage?.onDiscard}
                  folderNote={manage?.folderNote}
                  entryNote={entryNote}
                  onDropped={setDropped}
                  hint={header ? t("fileWorkspace.arrangeHint") : undefined}
                />
              </>
            ) : workspace.result.length === 0 ? (
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
        </>
      )}
    </section>
  );
}

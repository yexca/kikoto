import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Captions,
  CheckCircle2,
  Cloud,
  FolderOpen,
  HardDrive,
  Languages,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FloatingSelect, type FloatingSelectOption } from "@/components/ui/floating-select";
import { ConfirmMediaBatchDeleteDialog } from "@/features/work-detail/dialogs/ConfirmMediaBatchDeleteDialog";
import {
  buildFolderEditTree,
  folderEditSelectedBytes,
  withFolderEditPaths,
  type FolderEditFile,
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
import type { FileWorkspacePlace } from "@/features/work-detail/folder-edit/fileWorkspaceModel";
import { PlaceBadge, placeTone } from "@/features/work-detail/folder-edit/FolderWorkspaceTools";
import { lyricsEditResourceChanges, type LyricsEditResource } from "@/features/work-detail/lyrics/lyricsEditModel";
import { lyricsFileTrackCounts, managedLyricsLanguage } from "@/features/work-detail/lyrics/managedLyricsModel";
import { useLyricsEditWorkspace, type LyricsEditWorkspace } from "@/features/work-detail/lyrics/useLyricsEditWorkspace";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { languageLabel } from "@/features/work-detail/workflows/RemoteFetchWorkspaceTrees";
import type { MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import type { MediaItem, WorkFolderLocation } from "@/lib/api";
import { lyricsLanguageFolderPath, lyricsLanguages } from "@/lib/lyricsLanguage";
import { cn } from "@/lib/tailwindClassNames";

type LyricsPane = "sources" | "select" | "result";

/** A select value cannot be empty, so every language has its own. */
const allLanguagesValue = "all";
const noFiles: FolderEditFile[] = [];
const noSelection: ReadonlySet<string> = new Set();

/**
 * Edits the lyrics Kikoto manages in one local folder of a work, in three
 * columns: where lyrics can come from, the lyrics files of the chosen place,
 * and the managed lyrics as they will be. The managed lyrics are the first
 * place; clearing a file there deletes it.
 */
export function LyricsFilesWorkspace({
  workId,
  items,
  folder,
  folders,
  canAssign,
  startInFolderLyrics = false,
  localOnly = false,
  onFolderChange,
  onBusyChange,
  onApplied,
  onClose,
}: {
  workId: number;
  items: MediaItem[];
  /** The folder whose lyrics are edited. */
  folder: WorkFolderLocation;
  /** Every folder of the work that can be edited. */
  folders: WorkFolderLocation[];
  canAssign: boolean;
  /** Opens on the folder's other lyrics instead of the managed lyrics. */
  startInFolderLyrics?: boolean;
  /** Lists only local places, for a custom work that no remote source has. */
  localOnly?: boolean;
  onFolderChange: (folderId: number) => void;
  onBusyChange: (busy: boolean) => void;
  onApplied: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const target = useMemo<FolderEditTarget>(
    () => ({ workId, folderId: folder.id, rootPath: folder.rootPath }),
    [folder.id, folder.rootPath, workId],
  );
  const workspace = useLyricsEditWorkspace({ target, items, canAssign, startInFolderLyrics, localOnly, onApplied });
  const [pane, setPane] = useState<LyricsPane>(startInFolderLyrics ? "select" : "sources");
  const [confirmation, setConfirmation] = useState<{ step: 1 | 2; targets: MediaDeleteTarget[] } | null>(null);
  const trackCounts = useMemo(() => lyricsFileTrackCounts(items), [items]);
  const tracksByLocation = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of items) {
      const tracks = trackCounts.get(item.id) ?? 0;
      if (tracks > 0) for (const location of item.locations) counts.set(location.id, tracks);
    }
    return counts;
  }, [items, trackCounts]);
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
  const { applying } = workspace;
  useEffect(() => {
    onBusyChange(applying);
    return () => onBusyChange(false);
  }, [applying, onBusyChange]);
  const startApply = () => {
    if (removalTargets.length > 0) setConfirmation({ step: 1, targets: removalTargets });
    else void workspace.apply();
  };
  const paneCounts: Record<LyricsPane, number> = {
    sources: workspace.resources.length,
    select: workspace.request.additions.length,
    result: workspace.result.filter(
      (entry) =>
        entry.state !== "remove" && entry.state !== "excluded" && entry.state !== "moved" && entry.state !== "replaced",
    ).length,
  };
  const paneLabels: Record<LyricsPane, string> = {
    sources: t("folderEdit.pane.sources"),
    select: t("folderEdit.pane.select"),
    result: t("lyricsFiles.managed"),
  };

  return (
    <>
      <PaneSwitch
        panes={(["sources", "select", "result"] as const).map((value) => ({
          value,
          label: paneLabels[value],
          count: paneCounts[value],
        }))}
        value={pane}
        onChange={setPane}
      />
      <div
        className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[17rem_minmax(0,1fr)_minmax(0,25rem)]"
        data-kikoto-lyrics-files=""
      >
        <ResourceColumn
          workspace={workspace}
          active={pane === "sources"}
          onSelect={(resource) => {
            workspace.selectResource(resource);
            setPane("select");
          }}
        />
        <SelectionColumn workspace={workspace} active={pane === "select"} tracksByLocation={tracksByLocation} />
        <ResultColumn
          workspace={workspace}
          folder={folder}
          folders={folders}
          active={pane === "result"}
          onFolderChange={onFolderChange}
        />
      </div>
      <LyricsFilesFooter
        workspace={workspace}
        onReview={(next) => setPane(next)}
        onApply={startApply}
        onClose={onClose}
      />
      {confirmation &&
        // The confirmation is its own dialog beside the lyrics manager, not inside it.
        createPortal(
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
          />,
          document.body,
        )}
    </>
  );
}

function resourceTitle(resource: LyricsEditResource, t: (key: string) => string) {
  if (resource.kind === "current") return t("lyricsFiles.managed");
  if (resource.kind === "folder") return t("lyricsFiles.thisFolder");
  return languageLabel(resource.editionLanguage, t);
}

const resourceIcons: Record<LyricsEditResource["kind"], LucideIcon> = {
  current: Captions,
  folder: FolderOpen,
  local: HardDrive,
  remote: Cloud,
};

/** The edited folder holds both the managed lyrics and its other lyrics; other places are only read from. */
function lyricsResourcePlace(resource: LyricsEditResource): FileWorkspacePlace {
  if (resource.kind === "current" || resource.kind === "folder") return "target";
  return resource.kind;
}

/** The managed lyrics per language, such as "Japanese 2 · Simplified Chinese 1", in the languages' order. */
function managedLanguageSummary(files: readonly FolderEditFile[], t: (key: string) => string) {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = managedLyricsLanguage(file.path);
    if (language !== null) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return lyricsLanguages
    .filter(([language]) => counts.has(language))
    .map(([language, labelKey]) => `${t(labelKey)} ${counts.get(language)}`)
    .join(" · ");
}

function ResourceColumn({
  workspace,
  active,
  onSelect,
}: {
  workspace: LyricsEditWorkspace;
  active: boolean;
  onSelect: (resource: LyricsEditResource) => void;
}) {
  const { t } = useTranslation();
  const groups = [
    {
      key: "local",
      label: t("folderEdit.local"),
      items: workspace.resources.filter((resource) => resource.kind !== "remote"),
      empty: "",
    },
    {
      key: "remote",
      label: t("folderEdit.remote"),
      items: workspace.resources.filter((resource) => resource.kind === "remote"),
      empty: t("folderEdit.noRemoteSources"),
    },
  ].filter((group) => !(workspace.localOnly && group.key === "remote"));
  // The place list loads with the remote sources; without them its state shows under local places.
  const statusGroup = workspace.localOnly ? "local" : "remote";
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
          <ColumnLabel className="mb-2">{group.label}</ColumnLabel>
          <div className="space-y-1.5">
            {group.items.map((resource) => {
              const own = resource.kind === "current" || resource.kind === "folder";
              const state = workspace.files[resource.id];
              const languages =
                resource.kind === "current" && state?.status === "ready" ? managedLanguageSummary(state.files, t) : "";
              return (
                <ResourceOption
                  key={resource.id}
                  icon={resourceIcons[resource.kind]}
                  stripe={placeTone[lyricsResourcePlace(resource)].band}
                  title={resourceTitle(resource, t)}
                  noteTone={resource.offline ? "warning" : "muted"}
                  note={
                    resource.offline
                      ? t("libraryOffline.badge")
                      : !own && resource.origin
                        ? t("remoteFetch.origin")
                        : undefined
                  }
                  code={own ? undefined : resource.editionCode}
                  detail={languages || (resource.kind === "remote" ? resource.sourceName : resource.rootPath)}
                  removes={resource.kind === "current"}
                  selected={workspace.activeResource.id === resource.id}
                  changes={lyricsEditResourceChanges(
                    resource,
                    state?.status === "ready" ? state.files : undefined,
                    workspace.selection[resource.id],
                  )}
                  disabled={workspace.applying || Boolean(resource.offline)}
                  onSelect={() => onSelect(resource)}
                />
              );
            })}
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
      ))}
    </aside>
  );
}

function SelectionColumn({
  workspace,
  active,
  tracksByLocation,
}: {
  workspace: LyricsEditWorkspace;
  active: boolean;
  tracksByLocation: ReadonlyMap<number, number>;
}) {
  const { t } = useTranslation();
  const resource = workspace.activeResource;
  const state = workspace.files[resource.id];
  const files = state?.status === "ready" ? state.files : noFiles;
  const selected = workspace.selection[resource.id] ?? noSelection;
  const tree = useMemo(() => buildFolderEditTree(files), [files]);
  const allPaths = useMemo(() => files.map((file) => file.path), [files]);
  const selectedCount = files.filter((file) => selected.has(file.path)).length;
  const bytes = folderEditSelectedBytes(files, selected);
  const language = workspace.language(resource);
  const place = lyricsResourcePlace(resource);
  const PlaceIcon = resourceIcons[resource.kind];
  // Selected lyrics wait for their language before anything is planned.
  const needsLanguage = language === null && selectedCount > 0;
  const setIncluded = (paths: readonly string[], included: boolean) =>
    workspace.setSelected(resource.id, withFolderEditPaths(selected, paths, included));
  const hint =
    resource.kind === "current"
      ? t("lyricsFiles.managedHint")
      : resource.kind === "folder"
        ? t(workspace.folderMode === "move" ? "lyricsFiles.folderMoveHint" : "lyricsFiles.folderCopyHint")
        : resource.kind === "local"
          ? t("lyricsFiles.localHint")
          : t("lyricsFiles.remoteHint", { source: resource.sourceName });
  const languageOptions: FloatingSelectOption[] = lyricsLanguages.map(([value, labelKey]) => ({
    value: value || allLanguagesValue,
    label: t(labelKey),
  }));
  return (
    <section
      aria-label={t("folderEdit.pane.select")}
      className={cn("min-h-0 flex-1 flex-col bg-card lg:flex lg:border-r", active ? "flex" : "hidden")}
    >
      <div className="shrink-0 border-b">
        <div className={cn("h-1", placeTone[place].band)} aria-hidden="true" />
        <div className="flex items-center justify-between gap-3 px-3 pb-2 pt-2.5 lg:px-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <PlaceIcon className={cn("mt-0.5 h-4 w-4 shrink-0", placeTone[place].text)} aria-hidden="true" />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{resourceTitle(resource, t)}</span>
                {(resource.kind === "local" || resource.kind === "remote") && (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{resource.editionCode}</span>
                )}
                {place !== "local" && <PlaceBadge place={place} />}
              </div>
              <div className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">
                {t("folderEdit.selectionSummary", { selected: selectedCount, total: files.length })}
                {selectedCount > 0 && bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
              </div>
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
        <p className="px-3 pb-2.5 text-xs text-muted-foreground lg:px-4">{hint}</p>
        {resource.kind !== "current" && (
          <div className="mx-3 mb-3 grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-y-2 rounded-lg border bg-muted/30 p-2.5 lg:mx-4">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Languages className="h-3.5 w-3.5" aria-hidden="true" />
              {t("lyricsManager.lyricsLanguage")}
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <div className="min-w-0 flex-1 basis-44 sm:max-w-60">
                <FloatingSelect
                  // Each place keeps its own declared language.
                  key={resource.id}
                  value={language === null ? "" : language || allLanguagesValue}
                  options={languageOptions}
                  onValueChange={(value) =>
                    workspace.setLanguage(resource.id, value === allLanguagesValue ? "" : value)
                  }
                  ariaLabel={t("lyricsManager.lyricsLanguage")}
                  ariaInvalid={needsLanguage}
                  triggerLabel={
                    language === null ? (
                      <span className={needsLanguage ? "text-warning-foreground" : "text-muted-foreground"}>
                        {t("lyricsManager.chooseLanguage")}
                      </span>
                    ) : undefined
                  }
                  className={cn(
                    "bg-background",
                    needsLanguage && "border-warning-border bg-warning-surface ring-1 ring-warning/30",
                  )}
                  disabled={workspace.applying}
                />
              </div>
              {language !== null && (
                <span
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-2xs",
                    placeTone.target.surface,
                    placeTone.target.border,
                    placeTone.target.text,
                  )}
                  title={t("lyricsFiles.targetFolder", { folder: lyricsLanguageFolderPath(language) })}
                >
                  <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{lyricsLanguageFolderPath(language)}</span>
                  <span className="sr-only">
                    {t("lyricsFiles.targetFolder", { folder: lyricsLanguageFolderPath(language) })}
                  </span>
                </span>
              )}
            </div>
            {resource.kind === "folder" && (
              <>
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("lyricsFiles.folderMode")}
                </span>
                <div className="min-w-0 sm:max-w-60">
                  <FloatingSelect
                    value={workspace.folderMode}
                    options={[
                      { value: "copy", label: t("lyricsFiles.folderModeCopy") },
                      { value: "move", label: t("lyricsFiles.folderModeMove") },
                    ]}
                    onValueChange={(value) => workspace.setFolderMode(value === "move" ? "move" : "copy")}
                    ariaLabel={t("lyricsFiles.folderMode")}
                    className="bg-background"
                    disabled={workspace.applying}
                  />
                </div>
                <label className="flex sm:col-span-2 cursor-pointer items-center gap-2 mt-0.5 border-t pt-2 text-xs text-muted-foreground">
                  <Checkbox
                    className="h-4 w-4"
                    checked={workspace.listManaged}
                    disabled={workspace.applying}
                    onCheckedChange={workspace.setListManaged}
                  />
                  {t("lyricsFiles.listManaged")}
                </label>
              </>
            )}
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
          <PaneNote>
            <PlaceIcon className="h-5 w-5" aria-hidden="true" />
            {t(resource.kind === "current" ? "lyricsFiles.emptyResult" : "lyricsFiles.noLyricsFiles")}
          </PaneNote>
        ) : (
          <SelectionNode
            // Folder open state belongs to the resource it was opened in.
            key={resource.id}
            node={tree}
            depth={0}
            selected={selected}
            disabled={workspace.applying}
            onToggle={setIncluded}
            meta={(file) => {
              const tracks = file.locationId === null ? 0 : (tracksByLocation.get(file.locationId) ?? 0);
              return tracks > 0 ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t("lyricsManager.usedByTracks", { count: tracks })}
                </span>
              ) : null;
            }}
            isRoot
          />
        )}
      </div>
    </section>
  );
}

function ResultColumn({
  workspace,
  folder,
  folders,
  active,
  onFolderChange,
}: {
  workspace: LyricsEditWorkspace;
  folder: WorkFolderLocation;
  folders: WorkFolderLocation[];
  active: boolean;
  onFolderChange: (folderId: number) => void;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildFolderEditTree(workspace.result), [workspace.result]);
  const added = workspace.result.filter((entry) => entry.state.startsWith("add_")).length;
  const removed = workspace.result.filter((entry) => entry.state === "remove").length;
  return (
    <section
      aria-label={t("lyricsFiles.managed")}
      className={cn("min-h-0 flex-1 flex-col bg-card lg:flex", active ? "flex" : "hidden")}
    >
      <div className={cn("shrink-0 border-b", placeTone.target.surface)}>
        <div className={cn("h-1", placeTone.target.band)} aria-hidden="true" />
        <div className="space-y-2 px-3 py-2.5 lg:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Captions className={cn("h-4 w-4 shrink-0", placeTone.target.text)} aria-hidden="true" />
            <span className="truncate text-sm font-medium">{t("lyricsFiles.managed")}</span>
            <PlaceBadge place="target" />
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
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
            </span>
          </div>
          {folders.length > 1 ? (
            <FloatingSelect
              value={String(folder.id)}
              options={folders.map((candidate) => ({
                value: String(candidate.id),
                label: <span className="font-mono text-xs">{candidate.rootPath}</span>,
              }))}
              onValueChange={(value) => onFolderChange(Number(value))}
              ariaLabel={t("lyricsFiles.folder")}
              disabled={workspace.applying}
              className="h-8 bg-background font-mono text-xs"
              contentClassName="max-w-[min(32rem,calc(100vw-1.5rem))]"
            />
          ) : (
            <div className="truncate font-mono text-2xs text-muted-foreground" title={folder.rootPath}>
              {folder.rootPath}
            </div>
          )}
        </div>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
        {workspace.result.length === 0 ? (
          <PaneNote>
            <Captions className="h-5 w-5" aria-hidden="true" />
            {t("lyricsFiles.emptyResult")}
          </PaneNote>
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

function LyricsFilesFooter({
  workspace,
  onReview,
  onApply,
  onClose,
}: {
  workspace: LyricsEditWorkspace;
  onReview: (pane: LyricsPane) => void;
  onApply: () => void;
  onClose: () => void;
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
        ) : workspace.applying ? (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <span className="truncate text-muted-foreground">{t("lyricsFiles.applying")}</span>
          </>
        ) : readiness === "undeclared" ? (
          <>
            <Languages className="h-4 w-4 shrink-0 text-warning" />
            <span className="truncate">{t("lyricsFiles.undeclared")}</span>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 px-2"
              onClick={() => {
                workspace.selectResource(workspace.undeclared[0]);
                onReview("select");
              }}
            >
              {t("remoteFetch.review")}
            </Button>
          </>
        ) : readiness === "refreshing" ? (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <span className="truncate text-muted-foreground">{t("remoteFetch.refreshingPreview")}</span>
          </>
        ) : readiness === "blocked" ? (
          <>
            <AlertTriangle className="h-4 w-4 shrink-0 text-error" />
            <span className="truncate text-error-foreground">
              {t("folderEdit.statusBlocked", { count: plan?.summary.conflict ?? 0 })}
            </span>
            <Button variant="ghost" size="sm" className="shrink-0 px-2 lg:hidden" onClick={() => onReview("result")}>
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
      {request.additions.length > 0 &&
        (workspace.canAssign ? (
          <label
            className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground"
            title={t("lyricsFiles.assignHint")}
          >
            <Checkbox
              className="h-4 w-4"
              checked={workspace.assign}
              disabled={workspace.applying}
              onCheckedChange={workspace.setAssign}
            />
            <span className="truncate">
              {t("lyricsFiles.assign")}
              {workspace.assign && workspace.assignments.length > 0 ? (
                <span className="ml-1 tabular-nums">({workspace.assignments.length})</span>
              ) : null}
            </span>
          </label>
        ) : (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={t("lyricsManager.assignNeedsWrite")}>
            {t("lyricsManager.assignNeedsWrite")}
          </span>
        ))}
      <div className="ml-auto flex gap-2">
        <Button variant="ghost" onClick={onClose} disabled={workspace.applying}>
          {t("content.close")}
        </Button>
        <Button onClick={onApply} disabled={readiness !== "ready" || workspace.applying || workspace.planFailed}>
          <CheckCircle2 className="h-4 w-4" />
          {t("folderEdit.apply")}
        </Button>
      </div>
    </div>
  );
}

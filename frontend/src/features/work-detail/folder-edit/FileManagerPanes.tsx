import { ChevronLeft, ChevronRight, Copy, CopyCheck, Merge } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import { fileWorkspacePlace, type FileWorkspacePlace } from "@/features/work-detail/folder-edit/fileWorkspaceModel";
import {
  CURRENT_FOLDER_RESOURCE,
  folderEditResourceChanges,
  withFolderEditPaths,
  type FolderEditResource,
} from "@/features/work-detail/folder-edit/folderEditModel";
import {
  FolderWorkspaceNavigationContext,
  type FolderWorkspace,
  type FolderWorkspaceManage,
  type FolderWorkspaceNavigation,
  type FolderWorkspaceRevealTarget,
} from "@/features/work-detail/folder-edit/folderWorkspace";
import {
  CheckSourcesButton,
  CopyMergeSwitch,
  ExtensionChips,
  ResultColumn,
  SelectionColumn,
  SourcesStatus,
  resourceNote,
  resourceTitle,
} from "@/features/work-detail/folder-edit/FolderWorkspaceColumns";
import { PlaceBadge, placeIcon, placeReason, placeTone } from "@/features/work-detail/folder-edit/FolderWorkspaceTools";
import { PendingDeletionPanel } from "@/features/work-detail/folder-edit/PendingDeletionPanel";
import { useStableCallback } from "@/hooks/useStableCallback";
import { cn } from "@/lib/tailwindClassNames";

const noSelection: ReadonlySet<string> = new Set();

/** A folder's own name, the last part of its path. */
function folderName(rootPath: string) {
  return rootPath.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || rootPath;
}

/**
 * Manage files on a wide screen, in three fixed columns: the other places on
 * the left, This folder in the middle, and the files the edit deletes on the
 * right. The other places start as one prompt for the work's other local
 * folders and one for its remote editions; opening one shows that place's
 * files, and the group's picker switches among its folders or editions. This
 * folder is the only place the edit writes, so it always shows the folder as
 * it will be and takes drops; the place on the left is a source whose files
 * are copied or downloaded into it.
 */
export function FileManagerPanes({
  workspace,
  manage,
  hints,
  notice,
  emptyResult,
}: {
  workspace: FolderWorkspace;
  manage: FolderWorkspaceManage;
  hints: (resource: FolderEditResource) => string;
  notice?: ReactNode;
  emptyResult: string;
}) {
  const { t } = useTranslation();
  // A workspace made active on a place, such as the remote edition a Fetch
  // adds once the work's places are listed, opens it.
  const activeId = workspace.activeResource.kind !== "current" ? workspace.activeResource.id : null;
  const [openId, setOpenId] = useState<string | null>(activeId);
  useEffect(() => {
    if (activeId) setOpenId(activeId);
  }, [activeId]);
  const [reveal, setReveal] = useState<(FolderWorkspaceRevealTarget & { seq: number }) | null>(null);
  const review = manage.identical?.review ?? null;
  const reviewing = openId === IDENTICAL_REVIEW && review !== null;
  const open = workspace.resources.find((resource) => resource.id === openId && resource.kind !== "current") ?? null;
  // A place loads when it is opened; one that failed stays failed until the
  // user retries it or opens it again.
  const openKey = open?.id ?? null;
  const loadOpen = useStableCallback((id: string) => {
    const resource = workspace.resources.find((candidate) => candidate.id === id);
    if (resource) workspace.openResource(resource);
  });
  useEffect(() => {
    if (openKey) loadOpen(openKey);
  }, [loadOpen, openKey]);
  // The review takes the left column, beside This folder; a file of another
  // folder opens that folder there, and a file of This folder scrolls to it.
  const navigation = useMemo<FolderWorkspaceNavigation>(
    () => ({
      showIdenticalReview: () => setOpenId(IDENTICAL_REVIEW),
      reveal: (target) => {
        if (target.resourceId !== CURRENT_FOLDER_RESOURCE) setOpenId(target.resourceId);
        setReveal((current) => ({ ...target, seq: (current?.seq ?? 0) + 1 }));
      },
    }),
    [],
  );
  const revealIn = (resourceId: string) =>
    reveal?.resourceId === resourceId ? { path: reveal.path, seq: reveal.seq } : null;
  return (
    <FolderWorkspaceNavigationContext.Provider value={navigation}>
      <div
        className="grid min-h-0 flex-1 divide-x"
        style={{
          gridTemplateColumns:
            open || reviewing
              ? "minmax(0, 1fr) minmax(0, 1.15fr) minmax(18rem, 22rem)"
              : "minmax(16rem, 20rem) minmax(0, 1fr) minmax(18rem, 22rem)",
        }}
      >
        {reviewing ? (
          <section aria-label={t("fileWorkspace.identical.title")} className="flex min-h-0 flex-col bg-card">
            <ReviewHeader onClose={() => setOpenId(null)} />
            {review}
          </section>
        ) : open ? (
          <SelectionColumn
            workspace={workspace}
            resource={open}
            hint={hints(open)}
            active
            manage={manage}
            reveal={revealIn(open.id)}
            header={
              <SourceHeader workspace={workspace} resource={open} onPick={setOpenId} onClose={() => setOpenId(null)} />
            }
          />
        ) : (
          <SourcePrompts
            workspace={workspace}
            identical={review ? (manage.identical?.count ?? 0) : 0}
            onOpen={(resource) => setOpenId(resource.id)}
            onReview={() => setOpenId(IDENTICAL_REVIEW)}
          />
        )}
        <ResultColumn
          workspace={workspace}
          notice={notice}
          emptyResult={emptyResult}
          active
          manage={manage}
          reveal={revealIn(CURRENT_FOLDER_RESOURCE)}
          header={<TargetHeader workspace={workspace} entry={manage.identical?.entry} />}
          tools={<TargetTools workspace={workspace} manage={manage} />}
        />
        <PendingDeletionPanel pending={manage.pending} disabled={workspace.applying} onKeep={manage.onKeep} />
      </div>
    </FolderWorkspaceNavigationContext.Provider>
  );
}

/** The left column's value while it shows the review of identical files. */
const IDENTICAL_REVIEW = "identical-review";

/** The review's head in the left column, with the way back to the other places. */
function ReviewHeader({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-2 py-2">
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 px-2"
        aria-label={t("fileWorkspace.closePlace")}
        title={t("fileWorkspace.closePlace")}
        onClick={onClose}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <CopyCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-sm font-medium">{t("fileWorkspace.identical.title")}</h2>
    </div>
  );
}

/**
 * The other places while none is open: one prompt for the work's other local
 * folders and one for all its remote editions, whatever source offers them.
 */
function SourcePrompts({
  workspace,
  identical,
  onOpen,
  onReview,
}: {
  workspace: FolderWorkspace;
  /** How many files of This folder have an identical copy to review. */
  identical: number;
  onOpen: (resource: FolderEditResource) => void;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  const groups = (["local", "remote"] as const)
    .filter((place) => !(workspace.localOnly && place === "remote"))
    .map((place) => ({ place, items: workspace.resources.filter((resource) => resource.kind === place) }));
  const none = groups.every((group) => group.items.length === 0);
  return (
    <aside aria-label={t("fileWorkspace.otherPlaces")} className="app-scroll min-h-0 overflow-auto bg-muted/30 p-3">
      <p className="px-1 pb-3 text-xs text-muted-foreground">{t("fileWorkspace.wideHint")}</p>
      <div className="space-y-2">
        {groups.map(({ place, items }) =>
          items.length === 0 ? null : (
            <SourcePrompt
              key={place}
              workspace={workspace}
              place={place}
              items={items}
              onOpen={() => onOpen(items.find((resource) => !resource.offline) ?? items[0])}
            />
          ),
        )}
        {none && workspace.sourcesStatus === "ready" && (
          <p className="px-1 text-xs text-muted-foreground">
            {workspace.localOnly ? t("fileWorkspace.noOtherFolders") : t("fileWorkspace.noOtherPlaces")}
          </p>
        )}
        <SourcesStatus workspace={workspace} />
        <CheckSourcesButton workspace={workspace} className="h-8 px-2 text-xs" />
        {identical > 0 && (
          <button
            type="button"
            onClick={onReview}
            className="flex min-h-14 w-full items-center gap-3 rounded-lg border bg-background py-2.5 pl-4 pr-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CopyCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t("fileWorkspace.identical.review")}</span>
              <span className="block text-2xs text-muted-foreground">
                {t("fileWorkspace.identical.found", { count: identical })}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        )}
      </div>
    </aside>
  );
}

function SourcePrompt({
  workspace,
  place,
  items,
  onOpen,
}: {
  workspace: FolderWorkspace;
  place: Exclude<FileWorkspacePlace, "target">;
  items: readonly FolderEditResource[];
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const Icon = placeIcon(place);
  const added = items.reduce((sum, resource) => {
    const state = workspace.files[resource.id];
    return (
      sum +
      folderEditResourceChanges(
        resource,
        state?.status === "ready" ? state.files : undefined,
        workspace.selection[resource.id],
      )
    );
  }, 0);
  const names = [...new Set(items.map((resource) => resource.sourceName))];
  const merged = (resource: FolderEditResource) => Boolean(workspace.merge?.folderIds.has(resource.folderId));
  const usable = items.some((resource) => !resource.offline);
  return (
    <button
      type="button"
      disabled={workspace.applying || !usable}
      onClick={onOpen}
      className={cn(
        "relative flex min-h-14 w-full items-center gap-3 overflow-hidden rounded-lg border bg-background py-2.5 pl-4 pr-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70",
        placeTone[place].border,
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", placeTone[place].band)} aria-hidden="true" />
      <Icon className={cn("h-4 w-4 shrink-0", placeTone[place].text)} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          {t(place === "local" ? "fileWorkspace.otherLocal" : "fileWorkspace.otherRemote", { count: items.length })}
        </span>
        {place === "remote" ? (
          <span className="block truncate text-2xs text-muted-foreground">{names.join(" · ")}</span>
        ) : (
          // Each folder says whether the edit copies from it or merges it.
          <span className="mt-1 block space-y-0.5">
            {items.map((resource) => (
              <span
                key={resource.id}
                className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground"
                title={resource.rootPath}
              >
                <span className="truncate">{folderName(resource.rootPath)}</span>
                {resource.offline ? (
                  <span className="shrink-0 text-warning-foreground">{t("libraryOffline.badge")}</span>
                ) : merged(resource) ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-error-foreground">
                    <Merge className="h-3 w-3" aria-hidden="true" />
                    {t("fileWorkspace.mode.merge")}
                  </span>
                ) : (
                  <span className={cn("inline-flex shrink-0 items-center gap-0.5", placeTone.local.text)}>
                    <Copy className="h-3 w-3" aria-hidden="true" />
                    {t("fileWorkspace.mode.copy")}
                  </span>
                )}
              </span>
            ))}
          </span>
        )}
      </span>
      {added > 0 && (
        <span
          className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-2xs font-medium tabular-nums text-primary"
          aria-label={t("folderEdit.addCount", { count: added })}
        >
          +{added}
        </span>
      )}
      {place === "remote" && <PlaceBadge place={place} />}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/**
 * The open place's head: a band in the color of what the edit may do there,
 * the picker among the places of its group, and a way back to the prompts.
 */
function SourceHeader({
  workspace,
  resource,
  onPick,
  onClose,
}: {
  workspace: FolderWorkspace;
  resource: FolderEditResource;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const place = fileWorkspacePlace(resource);
  const group = workspace.resources.filter((candidate) => candidate.kind === resource.kind);
  const options = group.map((candidate) => {
    const note = resourceNote(workspace, candidate, t);
    return {
      value: candidate.id,
      disabled: Boolean(candidate.offline),
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{resourceTitle(candidate, t)}</span>
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">{candidate.editionCode}</span>
          <span className="truncate text-2xs text-muted-foreground">
            {candidate.kind === "remote" ? candidate.sourceName : candidate.rootPath}
          </span>
          {note && <span className="shrink-0 text-2xs text-muted-foreground">{note}</span>}
        </span>
      ),
    };
  });
  const Icon = placeIcon(place);
  return (
    <div className={cn("shrink-0 border-b", placeTone[place].surface)}>
      <div className={cn("h-1", placeTone[place].band)} aria-hidden="true" />
      <div className="flex items-center gap-2 px-2 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2"
          aria-label={t("fileWorkspace.closePlace")}
          title={t("fileWorkspace.closePlace")}
          onClick={onClose}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Icon className={cn("h-4 w-4 shrink-0", placeTone[place].text)} aria-hidden="true" />
        <FloatingSelect
          value={resource.id}
          options={options}
          onValueChange={onPick}
          ariaLabel={t(place === "local" ? "fileWorkspace.pickLocal" : "fileWorkspace.pickRemote")}
          disabled={workspace.applying || group.length < 2}
          className="h-8 min-w-0 flex-1 bg-background text-xs"
        />
        {place !== "local" && <PlaceBadge place={place} />}
      </div>
      <div className="flex items-center gap-2 px-3 pb-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={resource.rootPath}>
          {resource.kind === "remote" ? resource.sourceName : resource.rootPath}
        </span>
        {place === "local" && <CopyMergeSwitch workspace={workspace} resource={resource} />}
      </div>
      <p className={cn("px-3 pb-2 text-2xs", placeTone[place].text)}>{placeReason(place, t)}</p>
    </div>
  );
}

/**
 * This folder's fixed head: the folder the edit changes, in its own color and
 * words, and `entry`, such as the way to find its identical files.
 */
function TargetHeader({ workspace, entry }: { workspace: FolderWorkspace; entry?: ReactNode }) {
  const { t } = useTranslation();
  const Icon = placeIcon("target");
  return (
    <div className={cn("shrink-0 border-b", placeTone.target.surface)}>
      <div className={cn("h-1", placeTone.target.band)} aria-hidden="true" />
      <div className="flex min-h-12 items-center gap-2 px-3 py-2">
        <Icon className={cn("h-4 w-4 shrink-0", placeTone.target.text)} aria-hidden="true" />
        <span className="text-sm font-medium">{t("folderEdit.currentFolder")}</span>
        <PlaceBadge place="target" />
        <span
          className="min-w-0 flex-1 truncate text-right font-mono text-2xs text-muted-foreground"
          title={workspace.rootPath}
        >
          {workspace.rootPath}
        </span>
        {entry}
      </div>
    </div>
  );
}

/** The edited folder's own tools in its column: keeping its files by format, and what a check for identical files found. */
function TargetTools({ workspace, manage }: { workspace: FolderWorkspace; manage: FolderWorkspaceManage }) {
  const { t } = useTranslation();
  const state = workspace.files[CURRENT_FOLDER_RESOURCE];
  const selected = workspace.selection[CURRENT_FOLDER_RESOURCE] ?? noSelection;
  return (
    <div className="space-y-2 pt-1">
      <ExtensionChips
        files={state?.status === "ready" ? state.files : []}
        selected={selected}
        disabled={workspace.applying}
        label={t("fileWorkspace.keepByFormat")}
        onToggle={(paths, included) =>
          workspace.setSelected(CURRENT_FOLDER_RESOURCE, withFolderEditPaths(selected, paths, included))
        }
      />
      {manage.identical?.status}
      {manage.thisFolderTools}
    </div>
  );
}

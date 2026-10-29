import {
  ChevronLeft,
  ChevronRight,
  Copy,
  CopyCheck,
  Layers,
  Merge,
  MousePointerClick,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import {
  fileWorkspacePlace,
  type FileWorkspacePlace,
  type PendingDeletions,
} from "@/features/work-detail/folder-edit/fileWorkspaceModel";
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
import { PendingDeletionPanel, PendingTotal } from "@/features/work-detail/folder-edit/PendingDeletionPanel";
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
          header={<TargetHeader workspace={workspace} manage={manage} />}
          tools={<TargetTools workspace={workspace} manage={manage} />}
        />
        <PendingDeletionPanel
          pending={manage.pending}
          disabled={workspace.applying}
          onKeep={manage.onKeep}
          header={<PendingHeader pending={manage.pending} />}
          footer={
            manage.forget && (
              <div className="shrink-0 border-t bg-card px-3 py-2.5">
                <p className="px-1 pb-1.5 text-2xs text-muted-foreground">{t("fileWorkspace.forgetHint")}</p>
                {manage.forget}
              </div>
            )
          }
          className="bg-muted/25"
        />
      </div>
    </FolderWorkspaceNavigationContext.Provider>
  );
}

/** The left column's value while it shows the review of identical files. */
const IDENTICAL_REVIEW = "identical-review";

type PaneTone = FileWorkspacePlace | "neutral" | "danger";

const paneTone: Record<PaneTone, { band: string; surface: string; tile: string }> = {
  target: {
    band: placeTone.target.band,
    surface: placeTone.target.surface,
    tile: cn("bg-background", placeTone.target.border, placeTone.target.text),
  },
  local: {
    band: placeTone.local.band,
    surface: placeTone.local.surface,
    tile: cn("bg-background", placeTone.local.border, placeTone.local.text),
  },
  remote: {
    band: placeTone.remote.band,
    surface: placeTone.remote.surface,
    tile: cn("bg-background", placeTone.remote.border, placeTone.remote.text),
  },
  neutral: { band: "bg-border", surface: "bg-card", tile: "bg-muted text-muted-foreground" },
  danger: { band: "bg-error", surface: "bg-card", tile: "border-error-border bg-error-surface text-error-foreground" },
};

/**
 * A column's head, the same in each column so they line up: a band, the
 * column's icon, its title with one line below it, and its actions. A place's
 * head takes the place's color; the others stay neutral, or red while the
 * column lists what the edit deletes.
 */
function PaneHead({
  tone,
  icon: Icon,
  title,
  badge,
  detail,
  leading,
  actions,
}: {
  tone: PaneTone;
  icon: LucideIcon;
  title: ReactNode;
  badge?: ReactNode;
  detail?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={cn("shrink-0 border-b", paneTone[tone].surface)}>
      <div className={cn("h-1", paneTone[tone].band)} aria-hidden="true" />
      <div className="flex min-h-14 items-center gap-2.5 px-3 py-2">
        {leading}
        <span
          className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg border", paneTone[tone].tile)}
          aria-hidden="true"
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-24 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {typeof title === "string" ? <h3 className="truncate text-sm font-semibold">{title}</h3> : title}
            {badge}
          </div>
          {detail && <div className="truncate text-2xs text-muted-foreground">{detail}</div>}
        </div>
        {actions && <div className="flex min-w-0 items-center gap-1.5 [&>*:last-child]:shrink-0">{actions}</div>}
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-1 h-8 w-8 shrink-0 px-0"
      aria-label={t("fileWorkspace.closePlace")}
      title={t("fileWorkspace.closePlace")}
      onClick={onClick}
    >
      <ChevronLeft className="h-4 w-4" />
    </Button>
  );
}

/** The review's head in the left column, with the way back to the other places. */
function ReviewHeader({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <PaneHead
      tone="neutral"
      icon={CopyCheck}
      title={t("fileWorkspace.identical.title")}
      leading={<BackButton onClick={onClose} />}
    />
  );
}

/** The head of the column that lists what the edit deletes, red once it deletes anything. */
function PendingHeader({ pending }: { pending: PendingDeletions }) {
  const { t } = useTranslation();
  const deleting = pending.files > 0;
  return (
    <PaneHead
      tone={deleting ? "danger" : "neutral"}
      icon={Trash2}
      title={t("fileWorkspace.pending.title")}
      detail={deleting ? undefined : t("fileWorkspace.pending.empty")}
      badge={deleting && <PendingTotal pending={pending} />}
    />
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
    <aside aria-label={t("fileWorkspace.otherPlaces")} className="flex min-h-0 flex-col bg-muted/25">
      <PaneHead
        tone="neutral"
        icon={Layers}
        title={t("fileWorkspace.otherPlaces")}
        actions={<CheckSourcesButton workspace={workspace} className="h-7 px-2 text-xs" />}
      />
      <div className="app-scroll min-h-0 flex-1 space-y-2 overflow-auto overscroll-contain p-3">
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
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            {workspace.localOnly ? t("fileWorkspace.noOtherFolders") : t("fileWorkspace.noOtherPlaces")}
          </p>
        )}
        <SourcesStatus workspace={workspace} />
        {identical > 0 && (
          <PromptCard
            icon={<PromptIcon icon={CopyCheck} className="bg-muted text-muted-foreground" />}
            title={t("fileWorkspace.identical.review")}
            onClick={onReview}
          >
            <span className="block text-2xs text-muted-foreground">
              {t("fileWorkspace.identical.found", { count: identical })}
            </span>
          </PromptCard>
        )}
        <p className="flex gap-2 px-1 pt-2 text-2xs leading-relaxed text-muted-foreground">
          <MousePointerClick className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("fileWorkspace.wideHint")}
        </p>
      </div>
    </aside>
  );
}

function PromptIcon({ icon: Icon, className }: { icon: LucideIcon; className: string }) {
  return (
    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", className)} aria-hidden="true">
      <Icon className="h-4 w-4" />
    </span>
  );
}

/** One way into another place or review from the left column, as a card that opens it. */
function PromptCard({
  icon,
  title,
  badges,
  disabled,
  className,
  onClick,
  children,
}: {
  icon: ReactNode;
  title: string;
  badges?: ReactNode;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group relative flex w-full items-start gap-3 overflow-hidden rounded-xl border bg-card p-3 text-left transition-colors hover:border-foreground/20 hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70",
        className,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex min-h-5 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
          {badges}
        </span>
        {children}
      </span>
      <ChevronRight
        className="mt-2.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
        aria-hidden="true"
      />
    </button>
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
    <PromptCard
      icon={<PromptIcon icon={Icon} className={cn(placeTone[place].surface, placeTone[place].text)} />}
      title={t(place === "local" ? "fileWorkspace.otherLocal" : "fileWorkspace.otherRemote", { count: items.length })}
      badges={
        added > 0 && (
          <span
            className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-2xs font-medium tabular-nums text-primary"
            aria-label={t("folderEdit.addCount", { count: added })}
          >
            +{added}
          </span>
        )
      }
      disabled={workspace.applying || !usable}
      className={place === "remote" ? "hover:border-place-remote-border" : "hover:border-place-local-border"}
      onClick={onOpen}
    >
      {place === "remote" ? (
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{names.join(" · ")}</span>
          <PlaceBadge place={place} />
        </span>
      ) : (
        // Each folder says whether the edit copies from it or merges it.
        <span className="mt-1.5 block space-y-1">
          {items.map((resource) => (
            <span
              key={resource.id}
              className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground"
              title={resource.rootPath}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{folderName(resource.rootPath)}</span>
              {resource.offline ? (
                <span className="shrink-0 text-warning-foreground">{t("libraryOffline.badge")}</span>
              ) : merged(resource) ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-error-surface px-1.5 py-px font-medium text-error-foreground">
                  <Merge className="h-3 w-3" aria-hidden="true" />
                  {t("fileWorkspace.mode.merge")}
                </span>
              ) : (
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px",
                    placeTone.local.surface,
                    placeTone.local.text,
                  )}
                >
                  <Copy className="h-3 w-3" aria-hidden="true" />
                  {t("fileWorkspace.mode.copy")}
                </span>
              )}
            </span>
          ))}
        </span>
      )}
    </PromptCard>
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
  const location = resource.kind === "remote" ? resource.sourceName : resource.rootPath;
  return (
    <>
      <PaneHead
        tone={place}
        icon={placeIcon(place)}
        leading={<BackButton onClick={onClose} />}
        title={
          group.length < 2 ? (
            <h3 className="flex min-w-0 items-baseline gap-2 text-sm font-semibold">
              <span className="truncate">{resourceTitle(resource, t)}</span>
              <span className="shrink-0 font-mono text-2xs font-normal text-muted-foreground">
                {resource.editionCode}
              </span>
            </h3>
          ) : (
            <FloatingSelect
              value={resource.id}
              options={options}
              onValueChange={onPick}
              ariaLabel={t(place === "local" ? "fileWorkspace.pickLocal" : "fileWorkspace.pickRemote")}
              disabled={workspace.applying}
              className="-ml-2 h-7 border-transparent bg-transparent px-2 text-sm font-semibold hover:bg-background/70"
            />
          )
        }
        // A local folder's Copy or Merge switch below says what the edit may do there.
        badge={place !== "local" || !workspace.merge ? <PlaceBadge place={place} /> : undefined}
        detail={
          <span className="font-mono" title={location}>
            {location}
          </span>
        }
      />
      <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2 lg:px-4">
        <p className="min-w-0 flex-1 text-2xs text-muted-foreground">{placeReason(place, t)}</p>
        {place === "local" && <CopyMergeSwitch workspace={workspace} resource={resource} />}
      </div>
    </>
  );
}

/**
 * This folder's fixed head: the folder the edit changes, in its own color and
 * words, the way to switch to another of the work's folders, and the way to
 * find its identical files.
 */
function TargetHeader({ workspace, manage }: { workspace: FolderWorkspace; manage: FolderWorkspaceManage }) {
  const { t } = useTranslation();
  return (
    <PaneHead
      tone="target"
      icon={placeIcon("target")}
      title={t("folderEdit.currentFolder")}
      badge={<PlaceBadge place="target" />}
      detail={
        manage.folderPicker ? undefined : (
          <span className="font-mono" title={workspace.rootPath}>
            {workspace.rootPath}
          </span>
        )
      }
      actions={
        <>
          {manage.folderPicker}
          {manage.refresh}
          {manage.identical?.entry}
        </>
      }
    />
  );
}

/** The edited folder's own tools in its column: keeping its files by format, and what a check for identical files found. */
function TargetTools({ workspace, manage }: { workspace: FolderWorkspace; manage: FolderWorkspaceManage }) {
  const { t } = useTranslation();
  const state = workspace.files[CURRENT_FOLDER_RESOURCE];
  const selected = workspace.selection[CURRENT_FOLDER_RESOURCE] ?? noSelection;
  return (
    <div className="space-y-2">
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

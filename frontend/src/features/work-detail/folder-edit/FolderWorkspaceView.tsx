import { AlertTriangle, CheckCircle2, Loader2, Redo2, Undo2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { FileManagerPanes } from "@/features/work-detail/folder-edit/FileManagerPanes";
import type { FolderEditResource } from "@/features/work-detail/folder-edit/folderEditModel";
import { PaneSwitch } from "@/features/work-detail/folder-edit/FolderEditPanes";
import type { FolderWorkspace, FolderWorkspaceManage } from "@/features/work-detail/folder-edit/folderWorkspace";
import {
  ResourceColumn,
  ResultColumn,
  SelectionColumn,
} from "@/features/work-detail/folder-edit/FolderWorkspaceColumns";
import { cn } from "@/lib/tailwindClassNames";

type EditPane = "sources" | "select" | "result" | "delete";
type ResultView = "folder" | "delete";

/** The workspace width from which Manage files shows its places side by side, like a file manager. */
const WIDE_WORKSPACE_PX = 1280;

/**
 * Builds one folder in three columns: where files can come from, the files of
 * the chosen place with the role each takes, and the folder as it will be.
 * With `manage`, a fourth view lists what the edit deletes, and a wide
 * workspace shows its places side by side instead.
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
  manage,
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
  manage?: FolderWorkspaceManage;
  onClose: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const [pane, setPane] = useState<EditPane>(initialPane === "delete" ? "result" : initialPane);
  const [resultView, setResultView] = useState<ResultView>(initialPane === "delete" ? "delete" : "folder");
  const body = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(body);
  const wide = Boolean(manage) && width >= WIDE_WORKSPACE_PX;
  const paneCounts: Record<EditPane, number> = {
    sources: workspace.resources.length,
    select: workspace.additionCount,
    result: workspace.result.filter((entry) => entry.state !== "remove" && entry.state !== "excluded").length,
    delete: manage?.pending.files ?? 0,
  };
  const panes: EditPane[] = manage ? ["sources", "select", "result", "delete"] : ["sources", "select", "result"];
  const shownPane: EditPane = pane === "result" && resultView === "delete" ? "delete" : pane;
  const showPane = (next: EditPane) => {
    setPane(next === "delete" ? "result" : next);
    if (next === "delete" || next === "result") setResultView(next === "delete" ? "delete" : "folder");
  };
  return (
    <Dialog
      onClose={onClose}
      size="full"
      dismissible={!workspace.applying}
      marker={marker}
      className={cn(
        "h-[var(--dialog-max-height)] bg-background md:h-[min(90dvh,var(--dialog-max-height))]",
        manage ? "max-w-[120rem]" : "max-w-7xl",
      )}
    >
      <DialogHeader
        title={title}
        description={description}
        icon={icon}
        onClose={onClose}
        closeLabel={t("content.close")}
      />
      {manage?.toolbar}
      {!wide && (
        <PaneSwitch
          panes={panes.map((value) => ({
            value,
            label: value === "delete" ? t("fileWorkspace.pending.short") : t(`folderEdit.pane.${value}`),
            count: paneCounts[value],
          }))}
          value={shownPane}
          onChange={showPane}
        />
      )}
      <div ref={body} className="flex min-h-0 flex-1 flex-col">
        {wide && manage ? (
          <FileManagerPanes
            workspace={workspace}
            manage={manage}
            hints={hints}
            notice={notice}
            emptyResult={emptyResult}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[17rem_minmax(0,1fr)_minmax(0,25rem)]">
            <ResourceColumn
              workspace={workspace}
              active={pane === "sources"}
              onSelect={(resource) => {
                workspace.selectResource(resource);
                setPane("select");
              }}
            />
            <SelectionColumn
              workspace={workspace}
              resource={workspace.activeResource}
              hint={hints(workspace.activeResource)}
              active={pane === "select"}
              manage={manage}
            />
            <ResultColumn
              workspace={workspace}
              notice={notice}
              emptyResult={emptyResult}
              active={pane === "result"}
              manage={manage}
              view={manage ? resultView : "folder"}
              onViewChange={setResultView}
            />
          </div>
        )}
      </div>
      <WorkspaceFooter
        workspace={workspace}
        statusIdle={statusIdle}
        statusReady={statusReady}
        applyingLabel={applyingLabel}
        applyLabel={applyLabel}
        onReviewConflicts={() => showPane("result")}
        onApply={onApply}
      />
    </Dialog>
  );
}

/** Follows an element's width, so a layout can depend on the room its container has. */
function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function WorkspaceFooter({
  workspace,
  statusIdle,
  statusReady,
  applyingLabel,
  applyLabel,
  onReviewConflicts,
  onApply,
}: {
  workspace: FolderWorkspace;
  statusIdle: string;
  statusReady: string;
  applyingLabel: string;
  applyLabel: string;
  onReviewConflicts: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const { readiness, undo } = workspace;
  const collision = workspace.arrange?.collision ?? null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t bg-muted/35 px-3 py-2.5 sm:px-5">
      <div
        aria-live="polite"
        className="flex min-h-8 min-w-0 basis-full items-center gap-2 text-sm sm:basis-0 sm:flex-1"
      >
        {collision !== null ? (
          <>
            <AlertTriangle className="h-4 w-4 shrink-0 text-error" />
            <span className="truncate text-error-foreground" title={collision}>
              {t("folderEdit.collision", { path: collision })}
            </span>
          </>
        ) : workspace.planFailed ? (
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
        ) : undo?.canRestore ? (
          <>
            <span className="truncate text-muted-foreground">{t("fileWorkspace.undone")}</span>
            <Button variant="ghost" size="sm" className="shrink-0 px-2" onClick={undo.restore}>
              <Redo2 className="h-4 w-4" />
              {t("fileWorkspace.restore")}
            </Button>
          </>
        ) : (
          <span className="truncate text-muted-foreground">{statusIdle}</span>
        )}
      </div>
      <div className="ml-auto flex gap-2">
        {undo && (
          <Button
            variant="ghost"
            disabled={!undo.canUndo || workspace.applying}
            title={t("fileWorkspace.undoAllHint")}
            onClick={undo.undoAll}
          >
            <Undo2 className="h-4 w-4" />
            {t("fileWorkspace.undoAll")}
          </Button>
        )}
        <Button
          onClick={onApply}
          disabled={readiness !== "ready" || workspace.applying || workspace.planFailed || collision !== null}
        >
          <CheckCircle2 className="h-4 w-4" />
          {applyLabel}
        </Button>
      </div>
    </div>
  );
}

import { Loader2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { PaneNote } from "@/features/work-detail/folder-edit/FolderEditPanes";
import {
  folderEditSelectedBytes,
  withFolderEditPaths,
  type FolderEditFile,
} from "@/features/work-detail/folder-edit/folderEditModel";
import type { FolderEditFilesState } from "@/features/work-detail/folder-edit/folderWorkspace";

const noFiles: FolderEditFile[] = [];
const noSelection: ReadonlySet<string> = new Set();

/**
 * What every file workspace keeps for each place, such as the folder edit and
 * the lyrics edit: the place's files as they load, and the paths chosen there.
 */
export type ResourceSelectionWorkspace = {
  files: Readonly<Record<string, FolderEditFilesState | undefined>>;
  selection: Readonly<Record<string, ReadonlySet<string> | undefined>>;
  setSelected: (resourceId: string, paths: ReadonlySet<string>) => void;
};

/**
 * One place's files and what is chosen in them, for a selection column. For
 * the `current` place a chosen file is kept; for any other it is added. Each
 * workspace draws its own header and tools around these.
 */
export function useResourceSelection(workspace: ResourceSelectionWorkspace, resourceId: string) {
  const state = workspace.files[resourceId];
  const files = state?.status === "ready" ? state.files : noFiles;
  const selected = workspace.selection[resourceId] ?? noSelection;
  const allPaths = useMemo(() => files.map((file) => file.path), [files]);
  const selectedCount = files.filter((file) => selected.has(file.path)).length;
  const bytes = folderEditSelectedBytes(files, selected);
  const setIncluded = (paths: readonly string[], included: boolean) =>
    workspace.setSelected(resourceId, withFolderEditPaths(selected, paths, included));
  return { state, files, selected, allPaths, selectedCount, bytes, setIncluded };
}

export type ResourceSelection = ReturnType<typeof useResourceSelection>;

/** Chooses every file of the place, or none. */
export function SelectAllNone({
  selection,
  applying,
  allLabel,
  noneLabel,
}: {
  selection: ResourceSelection;
  applying: boolean;
  allLabel?: string;
  noneLabel?: string;
}) {
  const { t } = useTranslation();
  const { files, allPaths, setIncluded } = selection;
  return (
    <div className="-mr-2 flex shrink-0 gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={applying || files.length === 0}
        onClick={() => setIncluded(allPaths, true)}
      >
        {allLabel ?? t("remoteFetch.all")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={applying || files.length === 0}
        onClick={() => setIncluded(allPaths, false)}
      >
        {noneLabel ?? t("remoteFetch.none")}
      </Button>
    </div>
  );
}

/** A place's file tree, or why it shows none: still loading, failed with a retry, or `empty`. */
export function ResourceFilesBody({
  state,
  empty,
  onRetry,
  children,
}: {
  state: FolderEditFilesState | undefined;
  empty: ReactNode;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
      {!state || state.status === "loading" ? (
        <PaneNote>
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("folderEdit.loadingFiles")}
        </PaneNote>
      ) : state.status === "error" ? (
        <PaneNote>
          {t("folderEdit.filesFailed")}
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t("folderEdit.retry")}
          </Button>
        </PaneNote>
      ) : state.files.length === 0 ? (
        <PaneNote>{empty}</PaneNote>
      ) : (
        children
      )}
    </div>
  );
}

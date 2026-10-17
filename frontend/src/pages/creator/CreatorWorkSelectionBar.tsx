import { GitFork, HardDriveDownload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { FetchConfirmDialog } from "@/components/work-collection/FetchConfirmDialog";
import { WorkSelectionAction, WorkSelectionBar } from "@/components/work-collection/WorkSelectionBar";
import type { CreatorWorkSelection } from "@/pages/creator/useCreatorWorkSelection";

/** The selection bar of a creator's works page, shown while selecting. */
export function CreatorWorkSelectionBar<W>({ selection }: { selection: CreatorWorkSelection<W> }) {
  const { t } = useTranslation();
  if (!selection.selectionMode) return null;
  return (
    <WorkSelectionBar
      selectedCount={selection.selectedWorks.length}
      scopeSelectableCount={selection.selectableWorks.length}
      scopeSelectedCount={selection.scopeSelectedCount}
      onSelectScope={selection.selectScope}
      onClear={selection.clear}
      onExit={selection.exit}
    >
      <WorkSelectionAction
        icon={<GitFork className="h-4 w-4" />}
        label={t("detailActions.fork")}
        count={selection.forkableWorks.length}
        disabled={selection.busy}
        onClick={() => void selection.bulkFork()}
      />
      <WorkSelectionAction
        icon={<HardDriveDownload className="h-4 w-4" />}
        label={t("detailActions.fetch")}
        count={selection.fetchableWorks.length}
        disabled={selection.busy}
        onClick={selection.bulkFetch}
      />
    </WorkSelectionBar>
  );
}

/** Confirms a bulk Fetch the selection bar started. */
export function CreatorWorkFetchConfirm<W>({ selection }: { selection: CreatorWorkSelection<W> }) {
  const { saveConfirm } = selection;
  if (!saveConfirm) return null;
  return (
    <FetchConfirmDialog
      count={saveConfirm.count}
      onClose={selection.closeSaveConfirm}
      onConfirm={() => void saveConfirm.run()}
    />
  );
}

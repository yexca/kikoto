import { ListMusic } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { WorkSelectionAction, WorkSelectionBar } from "@/components/work-collection/WorkSelectionBar";
import {
  FavoriteListMembershipPicker,
  type FavoriteListMembershipChanges,
} from "@/features/favorites/FavoriteListMembershipPicker";
import type { FavoriteList, Work } from "@/lib/api";

/**
 * The favorites selection bar and its bulk list picker. The picker belongs to
 * the bar and closes with it or an emptied selection. The page shows the bar
 * only while selecting.
 */
export function FavoriteSelectionBar({
  selectedWorks,
  pageWorkCount,
  userLists,
  mobile,
  busy,
  onSelectPage,
  onClear,
  onExit,
  onListCreated,
  onSave,
}: {
  selectedWorks: Work[];
  pageWorkCount: number;
  userLists: FavoriteList[];
  mobile: boolean;
  busy: boolean;
  onSelectPage: () => void;
  onClear: () => void;
  onExit: () => void;
  onListCreated: () => void;
  /** A saved change ends the selection, which closes the bar and its picker. */
  onSave: (changes: FavoriteListMembershipChanges) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const listActionRef = useRef<HTMLDivElement | null>(null);
  const pickerVisible = pickerOpen && selectedWorks.length > 0;
  return (
    <WorkSelectionBar
      selectedCount={selectedWorks.length}
      scopeSelectableCount={pageWorkCount}
      scopeSelectedCount={selectedWorks.length}
      onSelectScope={onSelectPage}
      onClear={onClear}
      onExit={onExit}
    >
      <div ref={listActionRef}>
        <WorkSelectionAction
          icon={<ListMusic className="h-4 w-4" />}
          label={t("favorites.changeLists")}
          count={selectedWorks.length}
          disabled={busy}
          className="w-full"
          aria-expanded={pickerVisible}
          onClick={() => setPickerOpen(!pickerVisible)}
        />
        <FavoriteListMembershipPicker
          open={pickerVisible}
          onOpenChange={setPickerOpen}
          anchorRef={listActionRef}
          mobile={mobile}
          workIDs={selectedWorks.map((work) => work.id)}
          favoriteLists={userLists}
          disabled={busy}
          onListCreated={onListCreated}
          onSave={onSave}
        />
      </div>
    </WorkSelectionBar>
  );
}

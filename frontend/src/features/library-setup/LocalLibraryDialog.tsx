import { HardDrive } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsNumberInput, SettingsRow } from "@/components/settings/SettingsSection";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect } from "@/components/ui/floating-select";
import type { FolderLyricsMode, LibraryLayout } from "@/lib/api";

import { LibraryLayoutEditor } from "./LibraryLayoutEditor";

export type LocalLibrarySettings = { localScanDepth: number; folderLyricsMode: FolderLyricsMode };

const SCAN_DEPTH_MAXIMUM = 8;

/**
 * Everything about the local library in one form: its mode, storage pools,
 * and Fetch pool, then the scan depth and how lyrics edits treat the work
 * folder's own lyrics. One Save writes the settings before the layout.
 */
export function LocalLibraryDialog({
  name,
  layout,
  failed,
  readOnly,
  settings,
  scanDepthMinimum,
  onSaved,
  onSaveSettings,
  onClose,
}: {
  name: string;
  layout: LibraryLayout | null;
  failed: boolean;
  readOnly: boolean;
  settings: LocalLibrarySettings;
  scanDepthMinimum: number;
  onSaved: (layout: LibraryLayout) => void;
  onSaveSettings: (settings: LocalLibrarySettings) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(settings);
  const settingsDirty =
    draft.localScanDepth !== settings.localScanDepth || draft.folderLyricsMode !== settings.folderLyricsMode;

  return (
    <Dialog onClose={onClose} size="lg" ariaLabel={name}>
      <DialogHeader icon={<HardDrive />} title={name} onClose={onClose} closeLabel={t("common.close")} />
      <DialogBody>
        {layout ? (
          <LibraryLayoutEditor
            key={layoutKey(layout)}
            layout={layout}
            readOnly={readOnly}
            onSaved={onSaved}
            onDone={onClose}
            onCancel={onClose}
            saveLabel={t("common.save")}
            childrenDirty={settingsDirty}
            onSaveChildren={() => onSaveSettings(draft)}
          >
            <div className="divide-y border-t">
              <SettingsRow
                title={t("maintenance.library.scanDepth")}
                description={
                  scanDepthMinimum > 1 ? t("librarySetup.scanDepthMinimum", { count: scanDepthMinimum }) : undefined
                }
              >
                <SettingsNumberInput
                  disabled={readOnly}
                  label={t("maintenance.library.scanDepth")}
                  value={draft.localScanDepth}
                  min={scanDepthMinimum}
                  max={SCAN_DEPTH_MAXIMUM}
                  integer
                  unit={t("sourceSetup.levels")}
                  onChange={(localScanDepth) => setDraft((current) => ({ ...current, localScanDepth }))}
                />
              </SettingsRow>
              <SettingsRow
                title={t("maintenance.library.folderLyricsMode")}
                description={t("maintenance.library.folderLyricsModeDescription")}
              >
                <FloatingSelect
                  value={draft.folderLyricsMode}
                  options={[
                    { value: "copy", label: t("lyricsFiles.folderModeCopy") },
                    { value: "move", label: t("lyricsFiles.folderModeMove") },
                  ]}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, folderLyricsMode: value === "move" ? "move" : "copy" }))
                  }
                  ariaLabel={t("maintenance.library.folderLyricsMode")}
                  disabled={readOnly}
                />
              </SettingsRow>
            </div>
          </LibraryLayoutEditor>
        ) : (
          <p className="text-sm text-muted-foreground">
            {failed ? t("librarySetup.loadFailed") : t("maintenance.cache.scanning")}
          </p>
        )}
      </DialogBody>
    </Dialog>
  );
}

// Remount the editor when the saved layout changes so its draft follows it.
function layoutKey(layout: LibraryLayout) {
  return [layout.mode, layout.fetchPool, ...layout.pools.map((pool) => `${pool.path}:${pool.online}`)].join("|");
}

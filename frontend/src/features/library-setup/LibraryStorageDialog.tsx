import { HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import type { LibraryLayout } from "@/lib/api";

import { LibraryLayoutEditor } from "./LibraryLayoutEditor";

/** Modal dialog for configuring library mode, storage pools, and the Fetch pool. */
export function LibraryStorageDialog({
  layout,
  failed,
  readOnly,
  onSaved,
  onClose,
}: {
  layout: LibraryLayout | null;
  failed: boolean;
  readOnly: boolean;
  onSaved: (layout: LibraryLayout) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onClose} size="lg" ariaLabel={t("librarySetup.title")}>
      <DialogHeader
        title={t("librarySetup.title")}
        description={t("librarySetup.description")}
        icon={<HardDrive />}
        onClose={onClose}
        closeLabel={t("common.close")}
      />
      <DialogBody>
        {layout ? (
          <LibraryLayoutEditor
            key={layoutKey(layout)}
            layout={layout}
            readOnly={readOnly}
            onSaved={onSaved}
            onDone={onClose}
            onCancel={onClose}
          />
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

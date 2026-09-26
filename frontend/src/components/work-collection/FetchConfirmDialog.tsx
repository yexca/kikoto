import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";

/** Confirms a bulk Fetch, which downloads each selected work's full remote directory. */
export function FetchConfirmDialog({
  count,
  onClose,
  onConfirm,
}: {
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onClose} size="sm">
      <DialogHeader
        title={t("detailActions.fetchRemoteDirectory")}
        description={t("detailActions.fetchRemoteDirectoryDescription", { count })}
      />
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("content.cancel")}
        </Button>
        <Button size="sm" onClick={onConfirm}>
          {t("detailActions.fetch")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import i18n from "@/i18n";

export function SaveConfirmDialog({
  count,
  onClose,
  onConfirm,
}: {
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog onClose={onClose} size="sm">
      <DialogHeader title={i18n.t("libraryDetail.fetchRemoteDirectory")} />
      <DialogBody>
        <p className="text-sm text-muted-foreground">
          {i18n.t("libraryDetail.fetchRemoteDirectoryDescription", { count })}
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {i18n.t("content.cancel")}
        </Button>
        <Button size="sm" onClick={onConfirm}>
          {i18n.t("detailActions.fetch")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

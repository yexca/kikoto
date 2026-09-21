import { GitBranchPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import i18n from "@/i18n";

export function ReforkConfirmDialog({
  currentName,
  nextName,
  busy,
  onClose,
  onConfirm,
}: {
  currentName: string;
  nextName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog onClose={onClose} size="lg" dismissible={false}>
      <DialogHeader
        title={i18n.t("libraryDetail.switchForkSource")}
        description={i18n.t("libraryDetail.chooseDifferentRemoteSource")}
        onClose={onClose}
        closeLabel={i18n.t("content.close")}
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border bg-muted px-3 py-2 text-muted-foreground">
          {i18n.t("libraryDetail.forkReplacementNotice", { current: currentName, next: nextName })}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {i18n.t("content.cancel")}
        </Button>
        <Button onClick={onConfirm} disabled={busy}>
          <GitBranchPlus className="h-4 w-4" />
          {i18n.t("libraryDetail.switchForkSource")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

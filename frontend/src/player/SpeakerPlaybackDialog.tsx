import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";

/** Asks before playback starts through the device speaker. */
export function SpeakerPlaybackDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onCancel} layer="overlay-top" size="sm" role="alertdialog">
      <DialogHeader title={t("player.speakerConfirmTitle")} description={t("player.speakerConfirmDescription")} />
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("content.cancel")}
        </Button>
        <Button size="sm" onClick={onConfirm}>
          {t("player.speakerConfirmPlay")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

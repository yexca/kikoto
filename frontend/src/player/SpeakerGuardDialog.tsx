import { Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";

/** Asks before a held start plays out loud through the device's own speaker. */
export function SpeakerGuardDialog({ onPlay, onCancel }: { onPlay: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onCancel} size="sm" layer="overlay-top" role="alertdialog">
      <DialogHeader
        title={t("player.speakerPromptTitle")}
        description={t("player.speakerPromptDescription")}
        onClose={onCancel}
        closeLabel={t("content.close")}
      />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("content.cancel")}
        </Button>
        <Button onClick={onPlay}>
          <Volume2 className="h-4 w-4" />
          {t("player.playOnSpeaker")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

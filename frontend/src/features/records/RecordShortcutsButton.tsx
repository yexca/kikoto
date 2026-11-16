import { Keyboard } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { VideoShortcutList } from "@/player/video/VideoShortcutList";

/**
 * The player header's keyboard button, which lists the video shortcuts and
 * Esc. The list renders inside the player dialog, so it takes the dialog's
 * dark theme and stays above it.
 */
export function RecordShortcutsButton() {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const title = t("videoPlayback.shortcuts.title");
  return (
    <>
      <Button
        ref={buttonRef}
        variant="ghost"
        size="icon"
        className="h-11 w-11"
        aria-label={title}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Keyboard className="h-5 w-5" />
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={buttonRef}
        ariaLabel={title}
        onOpenChange={setOpen}
        container={open ? buttonRef.current?.closest("[aria-modal='true']") : null}
        className="w-[min(22rem,calc(100vw-1.5rem))] p-4"
      >
        <p className="mb-3 text-sm font-semibold">{title}</p>
        <VideoShortcutList extra={[{ keys: ["Esc"], label: t("records.player.close") }]} />
      </AnchoredPopover>
    </>
  );
}

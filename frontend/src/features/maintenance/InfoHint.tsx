import { Info } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";

/**
 * Compact explanation behind an info icon. It opens on mouse hover or keyboard
 * focus, and a tap pins it open for touch input. The text is always exposed to
 * assistive technology through `aria-describedby`.
 */
export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const descriptionId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const close = () => {
    setHovered(false);
    setFocused(false);
    setPinned(false);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="touch-target relative grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("maintenance.metadata.about", { label })}
        aria-describedby={descriptionId}
        onPointerEnter={(event) => event.pointerType === "mouse" && setHovered(true)}
        onPointerLeave={(event) => event.pointerType === "mouse" && setHovered(false)}
        onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible"))}
        onBlur={close}
        onClick={() => setPinned((current) => !current)}
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span id={descriptionId} className="sr-only">
        {children}
      </span>
      <AnchoredPopover
        open={hovered || focused || pinned}
        anchorRef={anchorRef}
        align="start"
        gap={6}
        zIndex={60}
        className="pointer-events-none max-w-[min(18rem,calc(100vw-1.5rem))] px-2.5 py-1.5 text-xs leading-5 shadow-md"
        onOpenChange={(open) => !open && close()}
      >
        <p aria-hidden="true">{children}</p>
      </AnchoredPopover>
    </>
  );
}

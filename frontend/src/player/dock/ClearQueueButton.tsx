import { ListX } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/tailwindClassNames";

const armedClassName =
  "rounded-full bg-destructive px-3 font-semibold text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80";

/**
 * Clears the whole queue in two steps: the first press arms the button in
 * place, a second press on it clears. Pressing anywhere else disarms it, as do
 * Escape and the timeout of the caller's `useArmedConfirm`.
 */
export function ClearQueueButton({
  appearance,
  armed,
  onArm,
  onDisarm,
  onClear,
  className,
}: {
  appearance: "icon" | "text";
  armed: boolean;
  onArm: () => void;
  onDisarm: () => void;
  onClear: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!armed) return;
    const disarmOutside = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node)) onDisarm();
    };
    document.addEventListener("pointerdown", disarmOutside, true);
    return () => document.removeEventListener("pointerdown", disarmOutside, true);
  }, [armed, onDisarm]);

  const restLabel = appearance === "icon" ? t("player.clearQueueTitle") : undefined;
  return (
    <button
      ref={buttonRef}
      type="button"
      data-player-no-drag
      data-armed={armed || undefined}
      className={cn(
        "touch-target relative inline-flex shrink-0 select-none items-center justify-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        armed
          ? cn(armedClassName, appearance === "icon" ? "h-7 text-xs" : "h-8 text-sm")
          : appearance === "icon"
            ? "h-8 w-8 rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/10"
            : "h-8 rounded-full px-3 text-sm font-semibold text-primary hover:bg-primary/10 active:bg-primary/15",
        className,
      )}
      aria-label={armed ? undefined : restLabel}
      title={armed ? undefined : restLabel}
      onClick={() => {
        if (!armed) {
          onArm();
          return;
        }
        onDisarm();
        onClear();
      }}
    >
      {armed ? (
        t("player.confirmClearQueue")
      ) : appearance === "icon" ? (
        <ListX className="h-[18px] w-[18px]" aria-hidden="true" />
      ) : (
        t("player.clearQueue")
      )}
    </button>
  );
}

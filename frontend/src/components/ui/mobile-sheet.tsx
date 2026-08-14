import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

export function MobileSheet({
  open,
  onOpenChange,
  ariaLabel,
  ariaLabelledby,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ariaLabel?: string;
  ariaLabelledby?: string;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", dismissWithEscape);
    return () => window.removeEventListener("keydown", dismissWithEscape);
  }, [onOpenChange, open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="visual-viewport-layer z-[70] flex items-end bg-transparent p-2 sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        data-android-back-close
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        className={cn(
          "theme-floating-surface app-scroll min-h-0 w-full overflow-y-auto rounded-t-xl border bg-card shadow-xl",
          className,
        )}
        style={{
          maxHeight: "calc(var(--visual-viewport-height) - 1rem)",
          paddingBottom: "max(0.5rem, var(--safe-area-bottom))",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/35" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

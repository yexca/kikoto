import { cloneElement, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwindClassNames";

// Icon controls inside the header tray: 44px on mobile, compact and round on
// wider screens where the tray border groups them.
export const trayButtonClass =
  "h-11 w-11 rounded-full text-muted-foreground hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground sm:h-8 sm:w-8";

export function HeaderPopover({
  open,
  onOpenChange,
  trigger,
  children,
  align = "left",
  ariaLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement<{ onClick?: () => void; "aria-expanded"?: boolean }>;
  children: ReactNode;
  align?: "left" | "right";
  ariaLabel?: string;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [bottomCollisionPadding, setBottomCollisionPadding] = useState(12);

  useEffect(() => {
    if (!open) return;
    const updatePlayerBoundary = () => {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const player = document.querySelector<HTMLElement>('[data-compact-player="true"]');
      if (!player || document.documentElement.dataset.playerMode !== "compact") {
        setBottomCollisionPadding(12);
        return;
      }
      const playerTop = player.getBoundingClientRect().top;
      const overlap = viewportBottom - playerTop;
      setBottomCollisionPadding(Math.max(12, overlap + 8));
    };

    updatePlayerBoundary();
    const player = document.querySelector<HTMLElement>('[data-compact-player="true"]');
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !player ? null : new ResizeObserver(updatePlayerBoundary);
    if (resizeObserver && player) resizeObserver.observe(player);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(updatePlayerBoundary);
    mutationObserver?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", updatePlayerBoundary);
    window.visualViewport?.addEventListener("resize", updatePlayerBoundary);
    window.visualViewport?.addEventListener("scroll", updatePlayerBoundary);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", updatePlayerBoundary);
      window.visualViewport?.removeEventListener("resize", updatePlayerBoundary);
      window.visualViewport?.removeEventListener("scroll", updatePlayerBoundary);
    };
  }, [open]);

  return (
    <div className="relative" ref={anchorRef}>
      {cloneElement(trigger, { onClick: () => onOpenChange(!open), "aria-expanded": open })}
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        align={align === "right" ? "end" : "start"}
        collisionPadding={8}
        bottomCollisionPadding={bottomCollisionPadding}
        ariaLabel={ariaLabel}
        onOpenChange={onOpenChange}
        className="max-w-[calc(100vw-1rem)] bg-card"
      >
        {children}
      </AnchoredPopover>
    </div>
  );
}

export function PopoverHeader({
  title,
  subtitle,
  action,
  onBack,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-14 items-center gap-2 border-b px-3 py-2">
      {onBack && (
        <Button
          variant="ghost"
          size="icon"
          className="-ml-1 h-8 w-8 shrink-0 rounded-full"
          aria-label={t("common.back")}
          title={t("common.back")}
          onClick={onBack}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{title}</div>
        {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}

export function MenuSection({
  label,
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("p-1.5", className)}>
      {label && <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">{label}</div>}
      {children}
    </div>
  );
}

export function ActionItem({
  icon,
  label,
  detail,
  busy,
  navigates,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  /** Low-emphasis current value shown before the chevron, such as the active theme. */
  detail?: string;
  busy?: boolean;
  /** Shows a chevron when the item opens a nested view instead of acting at once. */
  navigates?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-[var(--control-height)] w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted disabled:opacity-60"
      disabled={busy}
      onClick={onClick}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{detail}</span>}
      {navigates && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
    </button>
  );
}

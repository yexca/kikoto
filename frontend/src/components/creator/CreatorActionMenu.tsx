import { MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";

export type CreatorActionMenuItem = {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};

/** Overflow menu for secondary creator actions, such as workflow shortcuts. */
export function CreatorActionMenu({
  label,
  buttonLabel,
  items,
}: {
  label: string;
  /** Visible on wide layouts; phones show the icon only. */
  buttonLabel: string;
  items: CreatorActionMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (items.length === 0) return null;

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const menuItems = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (menuItems.length === 0) return;
    event.preventDefault();
    const current = menuItems.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? menuItems.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % menuItems.length
            : (current - 1 + menuItems.length) % menuItems.length;
    menuItems[next]?.focus();
  };

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <Button
        ref={buttonRef}
        variant={open ? "secondary" : "outline"}
        size="icon"
        className="h-[var(--control-icon-size)] w-[var(--control-icon-size)] lg:h-[var(--control-height-sm)] lg:w-auto lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="h-4 w-4" />
        <span className="hidden lg:inline">{buttonLabel}</span>
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        className="w-[min(15rem,calc(100vw-1.5rem))] p-1 text-sm"
        bottomCollisionPadding={96}
        zIndex={70}
      >
        <div id={menuId} ref={menuRef} role="menu" aria-label={label} onKeyDown={handleKeyDown}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
              onClick={() => {
                // Items usually navigate, which hides this page and defers its
                // updates; close first so the menu does not linger over the next page.
                flushSync(() => setOpen(false));
                item.onSelect();
              }}
            >
              <span className="shrink-0 text-muted-foreground">{item.icon}</span>
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

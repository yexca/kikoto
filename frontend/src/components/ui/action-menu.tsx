import { MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwindClassNames";

export type ActionMenuItem = {
  key: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  /** A second line, such as why the item is unavailable. */
  hint?: string;
  /** An item that deletes, shown in the error color. */
  destructive?: boolean;
  onSelect: () => void;
};

/** An overflow menu for secondary actions behind a "more" button. */
export function ActionMenu({
  label,
  buttonLabel,
  items,
  triggerClassName = "h-[var(--control-icon-size)] w-[var(--control-icon-size)] lg:h-[var(--control-height-sm)] lg:w-auto lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs",
  buttonLabelClassName = "hidden lg:inline",
  align = "end",
  keepWhenEmpty = false,
  toolbar = false,
  quiet = false,
  compact = false,
}: {
  label: string;
  /** Visible on wide layouts; phones show the icon only. */
  buttonLabel: string;
  items: ActionMenuItem[];
  triggerClassName?: string;
  buttonLabelClassName?: string;
  /** Which edge of the button the menu lines up with. */
  align?: "start" | "end";
  /** Shows a disabled button without items instead of nothing, so a toolbar keeps its layout. */
  keepWhenEmpty?: boolean;
  /** Matches the page toolbar's icon buttons instead of the outlined action button. */
  toolbar?: boolean;
  /** A borderless trigger for a row or tile that carries its own actions. */
  quiet?: boolean;
  /** Fits the menu to its items, for a menu of a few short ones. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (items.length === 0 && !keepWhenEmpty) return null;

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const menuItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
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
        variant={toolbar ? "toolbar" : open ? "secondary" : quiet ? "ghost" : "outline"}
        size={toolbar ? "icon-sm" : "icon"}
        className={
          toolbar
            ? "lg:w-auto lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs"
            : // The open look keeps the outline's border width, so the button does not shift.
              cn(open && "border border-transparent", triggerClassName)
        }
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={items.length === 0}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="h-4 w-4" />
        <span className={buttonLabelClassName}>{buttonLabel}</span>
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align={align}
        floatingLayer
        className={cn(
          "p-1 text-sm",
          compact ? "w-max min-w-32 max-w-[min(16rem,calc(100vw-1.5rem))]" : "w-[min(16rem,calc(100vw-1.5rem))]",
        )}
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
              disabled={item.disabled}
              className={cn(
                // The first item takes focus on open; only keyboard focus highlights it, so a click does not.
                "flex min-h-11 w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-muted focus:outline-none focus-visible:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent sm:min-h-9",
                item.disabled && "text-muted-foreground",
                item.destructive &&
                  !item.disabled &&
                  "text-error-foreground hover:bg-error-surface focus-visible:bg-error-surface",
              )}
              onClick={() => {
                // Items often navigate or open a dialog, which defers this
                // page's updates; close first so the menu does not linger.
                flushSync(() => setOpen(false));
                item.onSelect();
              }}
            >
              <span
                className={cn("mt-0.5 shrink-0", item.destructive && !item.disabled ? "" : "text-muted-foreground")}
              >
                {item.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                {item.hint && <span className="block text-xs text-muted-foreground">{item.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

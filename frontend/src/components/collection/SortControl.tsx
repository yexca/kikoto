import { ArrowDownWideNarrow, ArrowUpDown, ArrowUpNarrowWide, Check, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import type { SortDirection } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

export type SortControlOption<Value extends string> = { value: Value; label: string };

/**
 * A work collection's order as one split control. The main button names the
 * order and opens a menu of every order; the button beside it is the one
 * action the order has: flipping the direction, or drawing a new order for an
 * order that comes from a seed. The menu holds only the orders, so choosing
 * one closes it, and it is as wide as its longest name.
 */
export function SortControl<Value extends string>({
  options,
  value,
  direction,
  onChange,
  onDirectionChange,
  reshuffle,
  disabled = false,
  size = "sm",
  phone = false,
  align = "start",
}: {
  options: readonly SortControlOption<Value>[];
  value: Value;
  direction: SortDirection;
  onChange: (value: Value) => void;
  onDirectionChange: (direction: SortDirection) => void;
  /** Present while the current order draws from a seed; it replaces the direction. */
  reshuffle?: { label: string; onReshuffle: () => void; busy?: boolean };
  disabled?: boolean;
  /** Matches the control to an 8 or 10 unit row. */
  size?: "sm" | "md";
  /** Keeps the menu clear of the bottom navigation and player. */
  phone?: boolean;
  align?: "start" | "end";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const label = options.find((option) => option.value === value)?.label ?? t("library.sort");
  const medium = size === "md";
  const directionLabel = direction === "asc" ? t("library.ascending") : t("library.descending");
  const DirectionIcon = direction === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  const actionClassName = cn(
    "touch-target grid h-full shrink-0 place-items-center rounded-r-[var(--control-radius)] border-l text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
    medium ? "w-10" : "w-8",
  );

  return (
    // A narrow row truncates the order's name instead of overflowing.
    <div className="relative min-w-0" ref={anchorRef}>
      <div
        className={cn(
          "inline-flex min-w-0 max-w-full items-center rounded-[var(--control-radius)] border bg-background",
          medium ? "h-10" : "h-8",
        )}
      >
        <button
          type="button"
          className={cn(
            "touch-target inline-flex h-full min-w-0 items-center gap-1.5 rounded-l-[var(--control-radius)] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-muted",
            medium ? "max-w-56 px-3 text-sm" : "max-w-44 px-2.5 text-xs",
          )}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("library.sortLabel", { label })}
          title={t("library.sortLabel", { label })}
          onClick={() => setOpen((current) => !current)}
        >
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </button>
        {reshuffle ? (
          <button
            type="button"
            className={actionClassName}
            disabled={disabled || reshuffle.busy}
            aria-label={reshuffle.label}
            title={reshuffle.label}
            onClick={reshuffle.onReshuffle}
          >
            <RefreshCw className={cn("h-4 w-4", reshuffle.busy && "animate-spin")} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className={actionClassName}
            disabled={disabled}
            aria-label={directionLabel}
            title={directionLabel}
            onClick={() => onDirectionChange(direction === "asc" ? "desc" : "asc")}
          >
            <DirectionIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align={align}
        bottomCollisionPadding={phone ? 168 : undefined}
        className="w-max min-w-40 max-w-[min(13rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={t("library.sort")}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={cn(
                  "flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors hover:bg-muted",
                  selected ? "bg-primary/10 font-medium text-primary" : "text-foreground",
                )}
                onClick={() => {
                  setOpen(false);
                  if (!selected) onChange(option.value);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </div>
  );
}

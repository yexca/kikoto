import { ArrowDown, ArrowUp, ArrowUpDown, Check, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { LibrarySort, SortDirection } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

export type LibrarySortProps = {
  options: { value: LibrarySort; label: string }[];
  value: LibrarySort;
  direction: SortDirection;
  onChange: (value: LibrarySort) => void;
  onDirectionChange: (value: SortDirection) => void;
  onReshuffle: () => void;
  /** True while a reshuffled order is loading. */
  reshuffling?: boolean;
};

/**
 * The Library sort control: one button names the current order and its
 * direction, and its popover holds the orders with the direction, or the
 * reshuffle action for a random order. The toolbar variant matches the wide
 * layout's icon controls and adds a one-click reshuffle beside the button for
 * the orders that draw from a seed.
 */
export function LibrarySortButton({
  options,
  value,
  direction,
  onChange,
  onDirectionChange,
  onReshuffle,
  reshuffling = false,
  variant = "pill",
}: LibrarySortProps & { variant?: "pill" | "toolbar" }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const label = t(`library.sortOptions.${value}`, {
    defaultValue: options.find((option) => option.value === value)?.label ?? t("library.sort"),
  });
  const random = value === "random";
  const toolbar = variant === "toolbar";
  const reshuffleLabel = value === "recommend" ? t("library.refreshRecommendations") : t("library.reshuffle");
  const showReshuffle = toolbar && (random || value === "recommend");
  const directionLabel = direction === "asc" ? t("library.ascending") : t("library.descending");
  return (
    <div
      className={cn(
        "relative min-w-0",
        toolbar && "inline-flex h-8 shrink-0 items-center rounded-[var(--control-radius)] border bg-background",
      )}
      ref={anchorRef}
    >
      <button
        type="button"
        className={cn(
          "inline-flex max-w-full min-w-0 shrink items-center gap-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          toolbar
            ? cn(
                "h-full max-w-44 rounded-[var(--control-radius)] px-2.5 aria-expanded:bg-muted",
                showReshuffle && "rounded-r-none",
              )
            : "touch-target h-8 rounded-[var(--control-radius)] border bg-background px-2.5 aria-expanded:bg-muted",
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("library.sortLabel", { label })}
        title={toolbar ? t("library.sortLabel", { label }) : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{label}</span>
        {!random &&
          (direction === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ))}
      </button>
      {showReshuffle && (
        <Button
          variant="ghost"
          size="icon"
          className="h-full w-8 rounded-l-none border-l text-muted-foreground"
          disabled={reshuffling}
          onClick={onReshuffle}
          aria-label={reshuffleLabel}
          title={reshuffleLabel}
        >
          <RefreshCw className={cn("h-4 w-4", reshuffling && "animate-spin")} />
        </Button>
      )}
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        ariaLabel={t("library.sort")}
        bottomCollisionPadding={toolbar ? undefined : 168}
        className="w-[min(15rem,calc(100vw-1.5rem))] space-y-1.5 p-1.5 text-sm"
      >
        {random ? (
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-full gap-2"
            onClick={() => {
              onReshuffle();
              setOpen(false);
            }}
          >
            <RefreshCw className="h-4 w-4" />
            {t("library.reshuffle")}
          </Button>
        ) : (
          <div className={segmentedListClassName("grid w-full grid-cols-2")} role="group" aria-label={directionLabel}>
            {(["desc", "asc"] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={segmentedItemClassName(direction === item, "justify-center gap-1.5 px-2 text-xs")}
                aria-pressed={direction === item}
                onClick={() => onDirectionChange(item)}
              >
                {item === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                {item === "asc" ? t("library.ascending") : t("library.descending")}
              </button>
            ))}
          </div>
        )}
        <ul>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors hover:bg-muted",
                    selected ? "bg-primary/10 font-medium text-primary" : "text-foreground",
                  )}
                  aria-pressed={selected}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    {t(`library.sortOptions.${option.value}`, { defaultValue: option.label })}
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      </AnchoredPopover>
    </div>
  );
}

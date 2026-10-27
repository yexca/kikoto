import { Loader2, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/tailwindClassNames";

export type DialogTabItem<T extends string> = {
  value: T;
  icon: LucideIcon;
  label: string;
  /** A count beside the label, hidden at zero. */
  count?: number;
  /** A count that asks for attention, such as items waiting for review. */
  countTone?: "muted" | "warning";
  /** Something in the tab is working. */
  busy?: boolean;
};

/** A dialog's sections, as an underlined strip below its header. */
export function DialogTabs<T extends string>({
  tabs,
  value,
  label,
  disabled = false,
  onChange,
}: {
  tabs: readonly DialogTabItem<T>[];
  value: T;
  label: string;
  disabled?: boolean;
  onChange: (tab: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex shrink-0 gap-1 overflow-x-auto overflow-y-hidden border-b px-2 ![scrollbar-width:none] sm:px-3 [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map(({ value: tabValue, icon: Icon, label: tabLabel, count = 0, countTone = "muted", busy = false }) => {
        const active = tabValue === value;
        return (
          <button
            key={tabValue}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(tabValue)}
            className={cn(
              "relative inline-flex h-11 shrink-0 items-center gap-2 rounded-t-md px-3 text-sm font-medium transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              active
                ? "text-foreground after:bg-primary"
                : "text-muted-foreground after:bg-transparent hover:text-foreground",
            )}
          >
            <Icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} aria-hidden="true" />
            {tabLabel}
            {busy && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-info-foreground motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-2xs tabular-nums",
                  countTone === "warning"
                    ? "bg-warning-surface text-warning-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

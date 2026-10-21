import type { CollectionFilterOption } from "@/components/collection/CollectionFilterPicker";
import { cn } from "@/lib/tailwindClassNames";

/**
 * One-tap filter for a collection with a handful of fixed views. The chips
 * scroll sideways on a phone and wrap on wider layouts, and the pressed chip
 * names the active view without opening a menu.
 */
export function CollectionFilterChips<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: Value;
  options: readonly CollectionFilterOption<Value>[];
  onChange: (value: Value) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex gap-1.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] lg:flex-wrap lg:overflow-visible [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={cn(
              "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-[var(--badge-radius)] border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted",
              active
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

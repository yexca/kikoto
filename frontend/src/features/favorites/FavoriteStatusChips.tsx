import { BookmarkCheck, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";

import { quickMarkMeta } from "@/components/work-card/WorkCardShell";
import { cn } from "@/lib/tailwindClassNames";
import type { FavoriteStatusFilterOption } from "./favoriteShelfModel";
import type { FavoriteStatusFilter } from "./favoritesBrowseState";

/**
 * The phone Quick mark filters: one horizontally scrollable chip row with each
 * status's count on the shelf. A chip draws its quick mark color at rest and
 * the selected state as a subtle primary fill, so it reads as a filter below
 * the solid shelf chips that navigate. Choosing the selected chip again shows
 * every work.
 */
export function FavoriteStatusChips({
  options,
  value,
  onChange,
}: {
  options: FavoriteStatusFilterOption[];
  value: FavoriteStatusFilter;
  onChange: (value: FavoriteStatusFilter) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="scrollbar-hidden -mx-4 overflow-x-auto overflow-y-hidden overscroll-x-contain px-4"
      role="group"
      aria-label={t("favorites.statusFilters")}
    >
      <div className="flex w-max gap-1.5">
        {options.map((option) => {
          const active = option.value === value;
          const meta = option.value === "all" || option.value === "marked" ? null : quickMarkMeta(option.value);
          const Icon = meta?.icon ?? (option.value === "marked" ? BookmarkCheck : Layers);
          const empty = option.count === 0 && !active;
          return (
            <button
              key={option.value}
              type="button"
              className="group inline-flex h-11 shrink-0 items-center rounded-[var(--badge-radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100"
              aria-pressed={active}
              onClick={() => onChange(active && option.value !== "all" ? "all" : option.value)}
            >
              <span
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[var(--badge-radius)] border px-3 text-xs font-medium transition-colors",
                  active
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border bg-card text-foreground/80 group-hover:bg-muted group-hover:text-foreground",
                  empty && "opacity-60",
                )}
              >
                <Icon className={cn("h-3.5 w-3.5", !active && meta?.className)} aria-hidden="true" />
                {option.value === "all"
                  ? t("favorites.allStatuses")
                  : option.value === "marked"
                    ? t("favorites.anyMark")
                    : t(`library.status.${option.value}`)}
                <span className={cn("tabular-nums", active ? "text-primary/80" : "text-muted-foreground")}>
                  {option.count}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

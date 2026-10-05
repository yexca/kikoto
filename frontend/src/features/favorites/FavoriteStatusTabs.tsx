import { Layers } from "lucide-react";
import { useTranslation } from "react-i18next";

import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { quickMarkMeta } from "@/components/work-card/WorkCardShell";
import type { ListeningStatus } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import type { FavoriteStatusFilterOption } from "./favoriteShelfModel";

/** Listening status filters, drawn with the same icons as the card quick mark. */
export function FavoriteStatusTabs({
  options,
  value,
  onChange,
}: {
  options: FavoriteStatusFilterOption[];
  value: ListeningStatus | "all";
  onChange: (value: ListeningStatus | "all") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={segmentedListClassName("min-w-0")} role="group" aria-label={t("favorites.statusFilters")}>
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.value === "all" ? Layers : quickMarkMeta(option.value).icon;
        const empty = option.count === 0 && !active;
        return (
          <button
            key={option.value}
            type="button"
            className={segmentedItemClassName(active, cn("h-8 gap-1.5 px-2.5", empty && "opacity-60"))}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            <Icon className="h-3.5 w-3.5" />
            {option.value === "all" ? t("favorites.allStatuses") : t(`library.status.${option.value}`)}
            <span className="text-xs tabular-nums text-muted-foreground">{option.count}</span>
          </button>
        );
      })}
    </div>
  );
}

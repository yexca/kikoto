import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";

import { defaultFavoriteListIcon, favoriteListIconOptions } from "@/components/favorite-list/favoriteListIcons";
import { cn } from "@/lib/tailwindClassNames";

const choices = [{ key: "", icon: defaultFavoriteListIcon }, ...favoriteListIconOptions];

/** A radio group of list icons; arrow keys move the choice like any radio group. */
export function FavoriteListIconPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const groupRef = useRef<HTMLDivElement | null>(null);
  const labelID = useId();
  const selectedIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.key === value),
  );
  const labelFor = (key: string) => (key ? t(`favorites.iconNames.${key}`) : t("favorites.iconDefault"));
  const select = (index: number) => {
    const next = (index + choices.length) % choices.length;
    onChange(choices[next].key);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div className="grid gap-1.5 text-sm">
      <span id={labelID} className="text-xs font-medium text-muted-foreground">
        {t("favorites.icon")}
      </span>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby={labelID}
        className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1"
        onKeyDown={(event) => {
          const step =
            event.key === "ArrowRight" || event.key === "ArrowDown"
              ? 1
              : event.key === "ArrowLeft" || event.key === "ArrowUp"
                ? -1
                : 0;
          if (step === 0) return;
          event.preventDefault();
          select(selectedIndex + step);
        }}
      >
        {choices.map((choice, index) => {
          const selected = index === selectedIndex;
          const label = labelFor(choice.key);
          return (
            <button
              key={choice.key || "default"}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              title={label}
              tabIndex={selected ? 0 : -1}
              className={cn(
                "touch-target relative grid aspect-square place-items-center rounded-md border transition-[color,background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100",
                selected
                  ? "border-primary/40 bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
                  : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onClick={() => onChange(choice.key)}
            >
              <choice.icon className="h-[18px] w-[18px]" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

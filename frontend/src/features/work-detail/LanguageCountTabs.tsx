import { useEffect, useRef } from "react";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { cn } from "@/lib/tailwindClassNames";

/**
 * A language strip of the work's management dialogs: each language with how
 * many entries it covers, and a mark while it has unsaved changes.
 */
export function LanguageCountTabs({
  label,
  languages,
  selected,
  counts,
  pending,
  changedLabel,
  countTitle,
  onSelect,
}: {
  label: string;
  /** Each language with its label key. */
  languages: readonly (readonly [string, string])[];
  selected: string;
  counts: ReadonlyMap<string, number>;
  /** Languages with unsaved changes. */
  pending: ReadonlySet<string>;
  /** Read out on a language with unsaved changes. */
  changedLabel: string;
  countTitle?: (count: number) => string;
  onSelect: (language: string) => void;
}) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  // A narrow strip scrolls the selected language into view, keeping the page where it is.
  useEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>("[aria-selected=true]");
    if (!strip || !tab) return;
    const start = tab.offsetLeft - strip.offsetLeft;
    if (start < strip.scrollLeft || start + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = start - (strip.clientWidth - tab.offsetWidth) / 2;
    }
  }, [selected]);
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2">
      <Languages className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
      <div ref={stripRef} role="tablist" aria-label={label} className={segmentedListClassName("scrollbar-hidden")}>
        {languages.map(([language, labelKey]) => {
          const active = language === selected;
          const count = counts.get(language) ?? 0;
          return (
            <button
              key={language || "all"}
              type="button"
              role="tab"
              aria-selected={active}
              title={countTitle?.(count)}
              className={segmentedItemClassName(active, "relative h-9 gap-1.5 sm:h-8")}
              onClick={() => onSelect(language)}
            >
              {t(labelKey)}
              {count > 0 && (
                <span
                  className={cn(
                    "min-w-[1.125rem] rounded-full px-1 text-center text-2xs tabular-nums",
                    active ? "bg-primary/10 text-primary" : "bg-background/70 text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              )}
              {pending.has(language) && (
                <>
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-info" aria-hidden="true" />
                  <span className="sr-only">{changedLabel}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { Check, Gauge } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { FOR_YOU_TEMPERATURES, type ForYouTemperature } from "@/lib/forYouApi";
import { cn } from "@/lib/tailwindClassNames";

/**
 * The For you temperature as one toolbar button that names the current
 * choice, like the Library's order. Its popover lists the three choices, each
 * with the line that tells them apart, since their names alone do not.
 */
export function ForYouTemperaturePicker({
  value,
  onChange,
}: {
  /** Null until the saved choice has loaded. */
  value: ForYouTemperature | null;
  onChange: (value: ForYouTemperature) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const groupLabel = t("subscriptions.forYou.temperature.label");
  const label = value
    ? t("subscriptions.forYou.temperature.current", { value: t(`subscriptions.forYou.temperature.${value}`) })
    : groupLabel;
  return (
    <div className="relative min-w-0" ref={anchorRef}>
      <button
        type="button"
        className="touch-target inline-flex h-8 max-w-44 min-w-0 items-center gap-1.5 rounded-[var(--control-radius)] border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-muted"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        disabled={value === null}
        onClick={() => setOpen((current) => !current)}
      >
        <Gauge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{value ? t(`subscriptions.forYou.temperature.${value}`) : groupLabel}</span>
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        ariaLabel={groupLabel}
        bottomCollisionPadding={168}
        className="w-[min(16rem,calc(100vw-1.5rem))] p-1.5 text-sm"
      >
        <ul>
          {FOR_YOU_TEMPERATURES.map((item) => {
            const selected = item === value;
            return (
              <li key={item}>
                <button
                  type="button"
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted",
                    selected ? "bg-primary/10 text-primary" : "text-foreground",
                  )}
                  aria-pressed={selected}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) onChange(item);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className={cn("block", selected && "font-medium")}>
                      {t(`subscriptions.forYou.temperature.${item}`)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`subscriptions.forYou.temperature.hints.${item}`)}
                    </span>
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

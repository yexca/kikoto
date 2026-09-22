import { Filter } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";

export type CollectionFilterOption<Value extends string> = {
  value: Value;
  label: string;
};

/**
 * Toolbar filter control shared by collection surfaces: an icon button that
 * reports the current choice in its accessible name and opens a radio menu.
 * `label` names the menu and prefixes the button label, so a screen reader
 * hears the filter name together with the active choice, while a non-default
 * choice also shows the active dot.
 */
export function CollectionFilterPicker<Value extends string>({
  label,
  value,
  defaultValue,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  defaultValue: Value;
  options: readonly CollectionFilterOption<Value>[];
  onChange: (value: Value) => void;
}) {
  const { t } = useTranslation("translation", { i18n });
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? t("collection.filter");
  const active = value !== defaultValue;
  const buttonLabel = t("collection.filterValue", { label, value: selectedLabel });

  return (
    <div className="relative" ref={anchorRef}>
      <Button
        type="button"
        variant="toolbar"
        size="icon-sm"
        className="relative"
        aria-haspopup="menu"
        aria-expanded={open}
        title={buttonLabel}
        aria-label={buttonLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <Filter className="h-4 w-4" />
        {active && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        className="w-[min(13rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={label}>
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-foreground">
            <Filter className="h-4 w-4" />
            <span>{t("collection.filter")}</span>
          </div>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === option.value}
              className={`flex min-h-10 w-full items-center rounded-md px-3 py-2 text-left hover:bg-muted ${value === option.value ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

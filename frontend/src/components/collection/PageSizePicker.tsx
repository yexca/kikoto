import { Rows3 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import i18n from "@/i18n";

export function PageSizePicker({
  value,
  options,
  onChange,
}: {
  value: number;
  options: readonly number[];
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation("translation", { i18n });
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
        title={t("collection.pageSize", { value })}
        aria-label={t("collection.pageSize", { value })}
        onClick={() => setOpen((current) => !current)}
      >
        <Rows3 className="h-4 w-4" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        className="w-[min(13rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={t("collection.itemsPerPage")}>
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-foreground">
            <Rows3 className="h-4 w-4" />
            <span>{t("collection.itemsPerPage")}</span>
          </div>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={value === option}
              className={`flex min-h-10 w-full items-center rounded-md px-3 py-2 text-left hover:bg-muted ${value === option ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {t("collection.pageOption", { value: option })}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

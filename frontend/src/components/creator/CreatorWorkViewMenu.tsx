import { ListChecks, SlidersHorizontal, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";
import {
  WorkCollectionDisplayOptions,
  type WorkCollectionDisplayOptionsProps,
} from "@/components/work-collection/WorkCollectionLayout";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { cn } from "@/lib/tailwindClassNames";

/**
 * The View entry of a circle or voice actor's works: the display options
 * (card mode, columns, page size) and selecting works for bulk Fetch or Fork,
 * which would otherwise each take a toolbar control. Wide layouts open it as
 * a popover, phones as a sheet. A display choice leaves it open so several can
 * be adjusted; starting or ending a selection closes it.
 */
export function CreatorWorkViewMenu({
  display,
  selection,
}: {
  display: WorkCollectionDisplayOptionsProps;
  /** Set where the view selects works; the series overview does not. */
  selection?: { active: boolean; onToggle: () => void };
}) {
  const { t } = useTranslation();
  const mobile = useMobileNavigationLayout();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const title = t("detailActions.view");
  const label = selection?.active ? t("detailActions.viewSelecting") : title;

  const body = (
    <div className="flex flex-col gap-3">
      <WorkCollectionDisplayOptions {...display} />
      {selection && (
        <div className="border-t pt-2">
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-10"
            onClick={() => {
              setOpen(false);
              selection.onToggle();
            }}
          >
            <ListChecks
              className={cn("h-4 w-4 shrink-0", selection.active ? "text-primary" : "text-muted-foreground")}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">
              {selection.active ? t("library.cancelSelection") : t("sheets.selectWorks")}
            </span>
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <Button
        type="button"
        variant="toolbar"
        size="icon-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        {selection?.active && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />
        )}
      </Button>
      {mobile ? (
        <MobileSheet open={open} onOpenChange={setOpen} ariaLabel={title}>
          <MobileSheetHeader>
            <h2 className="text-base font-semibold">{title}</h2>
            <Button variant="ghost" size="icon" aria-label={t("common.close")} onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </MobileSheetHeader>
          <MobileSheetBody className="p-4">{body}</MobileSheetBody>
        </MobileSheet>
      ) : (
        <AnchoredPopover
          open={open}
          anchorRef={anchorRef}
          onOpenChange={setOpen}
          ariaLabel={title}
          className="w-[min(18rem,calc(100vw-1.5rem))] p-3 text-sm"
        >
          {body}
        </AnchoredPopover>
      )}
    </div>
  );
}

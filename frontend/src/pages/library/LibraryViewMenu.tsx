import { Columns3Cog, ListChecks, Sparkles, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";
import { Switch } from "@/components/ui/switch";
import {
  WorkCollectionDisplayOptions,
  type WorkCollectionDisplayOptionsProps,
} from "@/components/work-collection/WorkCollectionLayout";
import { cn } from "@/lib/tailwindClassNames";

/**
 * The Library's View entry: a button at the end of the toolbar and the panel
 * it opens, which holds how the results are drawn (the display options and
 * the recommendation score switch) and selecting remote works. The order, the
 * Quick mark filter, and recently played have their own toolbar controls.
 * Wide layouts open the panel as a popover, phones as a sheet. A choice leaves
 * the panel open so several can be adjusted.
 */
export function LibraryViewMenu({
  phone,
  display,
  recommendationScores,
  selection,
}: {
  phone: boolean;
  display: WorkCollectionDisplayOptionsProps;
  /** Null when the order already scores every work. */
  recommendationScores: { enabled: boolean; onToggle: () => void } | null;
  /** Set when the active view selects works for bulk actions. */
  selection: { active: boolean; onToggle: () => void } | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const scoresLabelId = useId();
  const title = t("library.view");

  const body = (
    <div className="flex flex-col gap-3">
      <WorkCollectionDisplayOptions {...display} />
      {recommendationScores && (
        <div className="flex min-h-10 items-center gap-2.5 px-0.5">
          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span id={scoresLabelId} className="min-w-0 flex-1 text-sm">
            {t("library.recommendationScores")}
          </span>
          <Switch
            className="touch-target"
            checked={recommendationScores.enabled}
            onCheckedChange={recommendationScores.onToggle}
            aria-labelledby={scoresLabelId}
          />
        </div>
      )}
      {selection && (
        <div className="border-t pt-2">
          <button
            type="button"
            className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              {selection.active ? t("library.cancelSelection") : t("collection.selectWorks")}
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
        size={phone ? "icon-sm" : "sm"}
        // A phone row has room for the icon alone.
        className={cn(!phone && "h-10 gap-1.5 px-3 text-sm")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        title={phone ? title : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Columns3Cog className="h-4 w-4" aria-hidden="true" />
        {!phone && title}
      </Button>
      {phone ? (
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
          className="w-[min(20rem,calc(100vw-1.5rem))] p-3 text-sm"
        >
          {body}
        </AnchoredPopover>
      )}
    </div>
  );
}

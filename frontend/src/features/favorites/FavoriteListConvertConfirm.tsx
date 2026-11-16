import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";

/** Confirms turning a smart list into a regular list beside the button that asked for it. */
export function FavoriteListConvertConfirm({
  name,
  listId,
  workCount,
  open,
  anchorRef,
  converting,
  onCancel,
  onConfirm,
}: {
  name: string;
  listId: number;
  /** Works the list shows now, which the conversion keeps. */
  workCount: number;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  converting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const titleID = `favorite-list-convert-${listId}-title`;
  const descriptionID = `favorite-list-convert-${listId}-description`;
  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onOpenChange={(next) => {
        if (!next && !converting) onCancel();
      }}
      className="w-[min(20rem,calc(100vw-1.5rem))] p-3"
      zIndex={60}
    >
      <div role="alertdialog" aria-labelledby={titleID} aria-describedby={descriptionID}>
        <h3 id={titleID} className="text-sm font-semibold">
          {t("favorites.smart.convertTitle")}
        </h3>
        <div id={descriptionID} className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <p>{t("favorites.smart.convertDescription", { count: workCount, name })}</p>
          <p>{t("favorites.smart.convertDetail")}</p>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={converting} autoFocus>
            {t("content.cancel")}
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} disabled={converting}>
            {converting ? t("favorites.smart.converting") : t("favorites.smart.convert")}
          </Button>
        </div>
      </div>
    </AnchoredPopover>
  );
}

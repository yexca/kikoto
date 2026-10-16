import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";

/** Confirms deleting one list beside the button that asked for it. */
export function FavoriteListDeleteConfirm({
  name,
  listId,
  open,
  anchorRef,
  deleting,
  onCancel,
  onConfirm,
}: {
  name: string;
  listId: number;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const titleID = `favorite-list-delete-${listId}-title`;
  const descriptionID = `favorite-list-delete-${listId}-description`;
  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onOpenChange={(next) => {
        if (!next && !deleting) onCancel();
      }}
      className="w-[min(18rem,calc(100vw-1.5rem))] p-3"
      zIndex={60}
    >
      <div role="alertdialog" aria-labelledby={titleID} aria-describedby={descriptionID}>
        <h3 id={titleID} className="text-sm font-semibold">
          {t("favorites.deleteListConfirm")}
        </h3>
        <p id={descriptionID} className="mt-2 text-sm text-muted-foreground">
          {t("favorites.deleteListDescription", { name })}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={deleting} autoFocus>
            {t("content.cancel")}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm} disabled={deleting}>
            {deleting ? t("favorites.deleting") : t("favorites.delete")}
          </Button>
        </div>
      </div>
    </AnchoredPopover>
  );
}

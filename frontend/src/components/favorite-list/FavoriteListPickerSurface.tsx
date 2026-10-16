import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";

/** Hosts a list picker: a popover beside its trigger, or a bottom sheet on phones. */
export function FavoriteListPickerSurface({
  open,
  onOpenChange,
  anchorRef,
  title,
  mobile,
  align = "end",
  dismissOnOutsidePointer = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
  title: string;
  mobile: boolean;
  align?: "start" | "end";
  /** Pending changes keep the popover open until they are applied or cancelled. */
  dismissOnOutsidePointer?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (mobile) {
    return (
      <MobileSheet open={open} onOpenChange={onOpenChange} ariaLabel={title}>
        <MobileSheetHeader>
          <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" aria-label={t("common.close")} onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </MobileSheetHeader>
        <MobileSheetBody className="p-0">{children}</MobileSheetBody>
      </MobileSheet>
    );
  }
  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      ariaLabel={title}
      align={align}
      dismissOnOutsidePointer={dismissOnOutsidePointer}
      onOpenChange={onOpenChange}
      className="flex w-72 flex-col overflow-hidden p-0 text-left"
    >
      {children}
    </AnchoredPopover>
  );
}

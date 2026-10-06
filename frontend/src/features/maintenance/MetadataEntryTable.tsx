import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * Shared look for the metadata entry tables (tags, circles, voice actors), so
 * they read like the works table: a muted header, divided rows that highlight
 * under the pointer, and icon actions pinned to the visible right edge.
 */
export const metadataTableClassName = "w-full text-left text-sm";
export const metadataHeadClassName = "border-b bg-muted/30 text-xs font-medium text-muted-foreground";
export const metadataBodyClassName = "divide-y";
export const metadataRowClassName = "group transition-colors hover:bg-muted/30";

// The pinned column must stay opaque while wider columns scroll beneath it, so
// it lays the same translucent muted wash over the card instead of using it as
// the background color.
// Written out in full so Tailwind can find both classes in source.
const mutedWash = "[background-image:linear-gradient(hsl(var(--muted)/0.3),hsl(var(--muted)/0.3))]";
const hoverMutedWash = "group-hover:[background-image:linear-gradient(hsl(var(--muted)/0.3),hsl(var(--muted)/0.3))]";
const stickyEdge = "sticky right-0 z-[1] bg-card";

export function MetadataActionsHeader() {
  const { t } = useTranslation();
  return (
    <th scope="col" className={`${stickyEdge} ${mutedWash} py-2 pr-1 text-right font-medium sm:pr-3`}>
      <span className="max-sm:sr-only">{t("unlinked.actions")}</span>
    </th>
  );
}

export function MetadataActionsCell({ children }: { children: ReactNode }) {
  return (
    <td className={`${stickyEdge} ${hoverMutedWash} py-2 pr-1 sm:pr-3`}>
      <div className="flex items-center justify-end gap-0.5">{children}</div>
    </td>
  );
}

/** Opens the entry's manage dialog; the accessible name says which entry. */
export function MetadataManageButton({ label, onClick }: { label: string; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="text-muted-foreground max-sm:h-11 max-sm:w-11"
      aria-label={label}
      title={t("metadataEntries.manage")}
      onClick={onClick}
    >
      <Pencil className="h-4 w-4" />
    </Button>
  );
}

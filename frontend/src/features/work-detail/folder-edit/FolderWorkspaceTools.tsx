import { Captions, Cloud, FolderOpen, HardDrive, Lock, PencilLine, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { FileWorkspacePlace } from "@/features/work-detail/folder-edit/fileWorkspaceModel";
import { cn } from "@/lib/tailwindClassNames";

const placeIcons: Record<FileWorkspacePlace, LucideIcon> = { target: FolderOpen, local: HardDrive, remote: Cloud };

/** The place role's color, used only to tell the workspace's places apart. */
export const placeTone: Record<FileWorkspacePlace, { band: string; text: string; surface: string; border: string }> = {
  target: {
    band: "bg-place-target",
    text: "text-place-target-foreground",
    surface: "bg-place-target-surface",
    border: "border-place-target-border",
  },
  local: {
    band: "bg-place-local",
    text: "text-place-local-foreground",
    surface: "bg-place-local-surface",
    border: "border-place-local-border",
  },
  remote: {
    band: "bg-place-remote",
    text: "text-place-remote-foreground",
    surface: "bg-place-remote-surface",
    border: "border-place-remote-border",
  },
};

export function placeIcon(place: FileWorkspacePlace) {
  return placeIcons[place];
}

/**
 * Says what an edit may do in a place, in words and with an icon, so the
 * place's color is never the only signal: the edited folder changes, and any
 * other place is only read from.
 */
export function PlaceBadge({ place, className }: { place: FileWorkspacePlace; className?: string }) {
  const { t } = useTranslation();
  const Icon = place === "target" ? PencilLine : Lock;
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-2xs font-medium",
        placeTone[place].surface,
        placeTone[place].border,
        placeTone[place].text,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(`fileWorkspace.place.${place}`)}
    </span>
  );
}

/** Why a place other than the edited folder offers no move or delete. */
export function placeReason(place: FileWorkspacePlace, t: (key: string) => string) {
  return place === "target" ? "" : t(`fileWorkspace.placeReason.${place}`);
}

/** Marks Kikoto's lyrics folder, whose files Manage lyrics arranges, and opens it there. */
export function ManagedLyricsTag({ onManageLyrics }: { onManageLyrics?: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="hidden items-center gap-1 text-2xs text-muted-foreground sm:inline-flex">
        <Captions className="h-3 w-3" aria-hidden="true" />
        {t("lyricsManager.managedByKikoto")}
      </span>
      {onManageLyrics && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onManageLyrics();
          }}
        >
          {t("detailActions.manageLyrics")}
        </Button>
      )}
    </span>
  );
}

/** Points the edited folder's own lyrics files to Manage lyrics, which makes them lyrics of a language. */
export function FolderLyricsNote({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
      <Captions className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-48">{t("fileWorkspace.folderLyrics", { count })}</span>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onOpen}>
        {t("fileWorkspace.openFolderLyrics")}
      </Button>
    </div>
  );
}

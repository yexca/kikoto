import {
  Captions,
  Cloud,
  CopyCheck,
  FolderOpen,
  HardDrive,
  Lock,
  PencilLine,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  compactLibraryPath,
  type FileWorkspacePlace,
  type FolderDuplicateMark,
  type FolderDuplicates,
} from "@/features/work-detail/folder-edit/fileWorkspaceModel";
import type { DuplicateFileCheck } from "@/features/work-detail/folder-edit/useDuplicateFileCheck";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
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

/**
 * Finds the edited folder's files that have an identical copy, and offers to
 * delete the redundant ones with the rest of the edit.
 */
export function DuplicateFileTools({
  check,
  duplicates,
  kept,
  sizes,
  disabled,
  onStart,
  onStop,
  onKeep,
}: {
  check: DuplicateFileCheck;
  duplicates: FolderDuplicates | null;
  /** The files of the edited folder the edit keeps. */
  kept: ReadonlySet<string>;
  /** Each file's size, by path. */
  sizes: ReadonlyMap<string, number | null>;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  onKeep: (paths: readonly string[], kept: boolean) => void;
}) {
  const { t } = useTranslation();
  if (check.status === "running") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="tabular-nums text-muted-foreground" role="status">
          {t("libraryDetail.identicalChecking", { checked: check.checkedFiles, pending: check.pendingFiles })}
        </span>
        <Button variant="ghost" size="sm" onClick={onStop}>
          {t("libraryDetail.identicalStop")}
        </Button>
      </div>
    );
  }
  const found = duplicates ? duplicates.elsewhere.length + duplicates.repeated.length : 0;
  const groups = duplicates
    ? [
        { key: "elsewhere", label: t("libraryDetail.identicalElsewhere"), paths: duplicates.elsewhere },
        { key: "repeated", label: t("libraryDetail.identicalRepeated"), paths: duplicates.repeated },
      ].filter((group) => group.paths.length > 0)
    : [];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button variant="outline" size="sm" disabled={disabled} onClick={onStart}>
        <Search className="h-4 w-4" />
        {check.status === "done" ? t("libraryDetail.identicalCheckAgain") : t("libraryDetail.identicalFind")}
      </Button>
      {check.status === "idle" && <span className="text-muted-foreground">{t("libraryDetail.identicalHint")}</span>}
      {check.status === "error" && (
        <span className="text-muted-foreground" role="status">
          {t("libraryDetail.identicalFailed")}
        </span>
      )}
      {duplicates && found === 0 && (
        <span className="text-muted-foreground" role="status">
          {t("libraryDetail.identicalNone")}
        </span>
      )}
      {groups.map((group) => {
        const marked = group.paths.filter((path) => !kept.has(path));
        const all = marked.length === group.paths.length;
        const bytes = group.paths.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0);
        return (
          <span
            key={group.key}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border bg-background pl-2.5 pr-1 text-xs"
          >
            <CopyCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium">{group.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {t("libraryDetail.filesCount", { count: group.paths.length })}
              {bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              disabled={disabled}
              onClick={() => onKeep(group.paths, all)}
            >
              {all ? t("fileWorkspace.keepThem") : t("fileWorkspace.deleteThem")}
            </Button>
          </span>
        );
      })}
    </div>
  );
}

/** Where a file of the edited folder has an identical copy. */
export function DuplicateMark({ mark }: { mark: FolderDuplicateMark }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground"
      title={`${mark.counterpart.workCode} · ${mark.counterpart.path}`}
    >
      <CopyCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {t(mark.elsewhere ? "libraryDetail.identicalToElsewhere" : "libraryDetail.identicalTo", {
          code: mark.counterpart.workCode,
          path: compactLibraryPath(mark.counterpart.path),
        })}
      </span>
    </div>
  );
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

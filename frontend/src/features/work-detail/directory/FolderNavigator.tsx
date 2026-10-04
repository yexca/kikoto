import { useRef, useState } from "react";
import {
  AudioLines,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderRoot,
  FolderTree,
  ImageIcon,
  Music,
  Sparkles,
} from "lucide-react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";
import { type FolderNavigatorRow, pathWithin, samePath } from "@/features/work-detail/directory/directoryModel";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import i18n from "@/i18n";
import { cn } from "@/lib/tailwindClassNames";

export type FolderNavigatorProps = {
  rows: FolderNavigatorRow[];
  currentPath: string[];
  recommendedPath: string[] | null;
  recommendedReason: string;
  playingPath: string[] | null;
  onSelect: (path: string[]) => void;
  onToggle: (key: string) => void;
};

function rowLabel(row: FolderNavigatorRow) {
  return row.labelParts.length > 0 ? row.labelParts.join(" / ") : i18n.t("libraryDetail.workRoot");
}

/** A compacted row stands for every folder in its chain, so any of them selects it. */
function rowSelected(row: FolderNavigatorRow, currentPath: string[]) {
  // The root row's chain starts at the root itself; any other chain at its first named folder.
  const chainStart = row.isRoot ? 0 : row.path.length - row.labelParts.length + 1;
  return currentPath.length >= chainStart && pathWithin(row.path, currentPath);
}

function RowCount({ row }: { row: FolderNavigatorRow }) {
  const { playable, images, files } = row.counts;
  if (row.isRoot && row.labelParts.length === 0) return null;
  const [Icon, count] =
    playable > 0 ? [Music, playable] : images > 0 && images === files ? [ImageIcon, images] : [null, files];
  if (count === 0) return null;
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 pl-1 text-2xs tabular-nums text-muted-foreground">
      {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
      {count}
    </span>
  );
}

export function FolderNavigatorList({
  rows,
  currentPath,
  recommendedPath,
  recommendedReason,
  playingPath,
  onSelect,
  onToggle,
}: FolderNavigatorProps) {
  return (
    <nav aria-label={i18n.t("libraryDetail.folders")}>
      <ul className="space-y-px">
        {rows.map((row) => {
          const label = rowLabel(row);
          const selected = rowSelected(row, currentPath);
          // A collapsed folder hiding the current one stays recognizable without claiming to be it.
          const holdsSelection = !selected && row.hasChildren && !row.expanded && pathWithin(currentPath, row.path);
          const recommended = samePath(row.path, recommendedPath);
          // A folder whose subfolders are hidden still shows that playback is inside it.
          const childrenVisible = row.isRoot || (row.expanded && row.hasChildren);
          const playing = childrenVisible ? samePath(row.path, playingPath) : pathWithin(playingPath, row.path);
          const Icon = playing ? AudioLines : row.isRoot ? FolderRoot : selected ? FolderOpen : Folder;
          return (
            <li key={row.key || "\u0000root"}>
              <div
                className={cn(
                  "flex min-h-9 items-center rounded-md transition-colors",
                  selected ? "bg-secondary text-secondary-foreground" : "hover:bg-muted",
                )}
                style={{ paddingLeft: Math.min(row.depth, 6) * 12 }}
              >
                {row.hasChildren ? (
                  <button
                    type="button"
                    className="grid h-8 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-expanded={row.expanded}
                    aria-label={i18n.t(row.expanded ? "libraryDetail.collapseFolder" : "libraryDetail.expandFolder", {
                      name: label,
                    })}
                    onClick={() => onToggle(row.key)}
                  >
                    <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", row.expanded && "rotate-90")} />
                  </button>
                ) : (
                  <span className="w-6 shrink-0" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded py-1.5 pr-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-current={selected ? "location" : undefined}
                  title={playing ? `${label} · ${i18n.t("libraryDetail.nowPlaying")}` : label}
                  onClick={() => onSelect(row.path)}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      playing && "motion-safe:animate-pulse",
                      playing || selected || holdsSelection ? "text-primary" : "text-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      "line-clamp-2 min-w-0 break-words leading-snug [overflow-wrap:anywhere]",
                      (selected || holdsSelection) && "font-medium",
                    )}
                  >
                    {label}
                  </span>
                  {recommended && (
                    <Sparkles className="h-3 w-3 shrink-0 text-primary" role="img" aria-label={recommendedReason} />
                  )}
                  <RowCount row={row} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Sticky folder column beside the folder contents on wide directories. */
export function FolderRail({ className, ...props }: FolderNavigatorProps & { className?: string }) {
  return (
    <aside
      className={cn(
        "app-scroll sticky top-20 max-h-[calc(100dvh-7rem)] self-start overflow-y-auto border-r pr-2",
        className,
      )}
    >
      <div className="px-2 pb-1.5 pt-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {i18n.t("libraryDetail.folders")}
      </div>
      <FolderNavigatorList {...props} />
    </aside>
  );
}

/** Opens the folder navigator from a compact directory: a sheet on phones, a popover elsewhere. */
export function FolderPickerButton({ className, ...props }: FolderNavigatorProps & { className?: string }) {
  const mobile = useMobileNavigationLayout();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const list = (
    <FolderNavigatorList
      {...props}
      onSelect={(path) => {
        props.onSelect(path);
        setOpen(false);
      }}
    />
  );
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open && "bg-muted text-foreground",
          className,
        )}
        aria-label={i18n.t("libraryDetail.showFolders")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={i18n.t("libraryDetail.showFolders")}
        onClick={() => setOpen((value) => !value)}
      >
        <FolderTree className="h-4 w-4" />
      </button>
      {mobile ? (
        <MobileSheet open={open} onOpenChange={setOpen} ariaLabel={i18n.t("libraryDetail.folders")}>
          <MobileSheetHeader>
            <span className="text-sm font-semibold">{i18n.t("libraryDetail.folders")}</span>
          </MobileSheetHeader>
          <MobileSheetBody className="[&_button]:min-h-11">{list}</MobileSheetBody>
        </MobileSheet>
      ) : (
        <AnchoredPopover
          open={open}
          anchorRef={buttonRef}
          onOpenChange={setOpen}
          align="start"
          className="app-scroll max-h-[min(28rem,70vh)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto p-1.5"
          bottomCollisionPadding={96}
          zIndex={70}
          ariaLabel={i18n.t("libraryDetail.folders")}
        >
          {list}
        </AnchoredPopover>
      )}
    </>
  );
}

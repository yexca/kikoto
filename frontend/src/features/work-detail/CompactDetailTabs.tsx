import { ChevronDown, ChevronLeft, ChevronRight, FolderTree } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import i18n from "@/i18n";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { cn } from "@/lib/tailwindClassNames";
import { DirectoryTabMenuContext } from "@/features/work-detail/directory/directoryTabMenu";
import { sourceTabStatusClass, type SourceTabInfo } from "@/features/work-detail/source/sourceContextModel";
import { DirectoryEditionList, type DirectoryEditionModel } from "@/features/work-detail/WorkVersionMenus";

/**
 * The Info and Directory switch of a compact detail, with the Directory's
 * source and name tools at the row's end. The source opens a popover where the
 * directory panel lists its sources; a phone has no source tab strip. A work
 * with another directory edition names the shown edition's language beside the
 * source, and the popover opens the edition list from its first row.
 */
export function CompactDetailTabs({
  activeTab,
  onActiveTabChange,
  source,
  edition,
  info,
  directory,
}: {
  activeTab: "info" | "directory";
  onActiveTabChange: (tab: "info" | "directory") => void;
  /** The source the Directory and Source info show, by its short name. */
  source: { label: string; status: SourceTabInfo["status"]; statusLabel: string };
  /** The directory editions, or null when the work has no other edition to choose. */
  edition?: DirectoryEditionModel | null;
  info: ReactNode;
  directory: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editionView, setEditionView] = useState(false);
  const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
  const [toolsHost, setToolsHost] = useState<HTMLElement | null>(null);
  const sourceButtonRef = useRef<HTMLButtonElement | null>(null);
  const changeMenuOpen = (open: boolean) => {
    setMenuOpen(open);
    if (!open) setEditionView(false);
  };
  const menu = useMemo(
    () => ({
      host: menuHost,
      tools: toolsHost,
      close: () => {
        setMenuOpen(false);
        setEditionView(false);
      },
    }),
    [menuHost, toolsHost],
  );
  const directoryActive = activeTab === "directory";
  const menuShown = directoryActive && menuOpen;
  const showingEditions = Boolean(edition) && editionView;
  const sourceTitle = i18n.t("libraryDetail.directorySource");
  const editionTitle = i18n.t("libraryDetail.directoryEdition");
  // The touch areas reach past the slim row to 44px; the row has room above and below.
  const tabClassName = (active: boolean) =>
    cn(
      "relative inline-flex h-full shrink-0 items-center px-3 font-medium transition-colors before:absolute before:-inset-y-1 before:inset-x-0 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
      active ? "text-foreground after:bg-primary" : "text-muted-foreground after:bg-transparent hover:text-foreground",
    );

  return (
    <>
      <div className="flex h-9 min-w-0 items-stretch gap-1 border-b text-sm">
        <button
          type="button"
          className={tabClassName(!directoryActive)}
          aria-pressed={!directoryActive}
          onClick={() => onActiveTabChange("info")}
        >
          {i18n.t("libraryDetail.info")}
        </button>
        <button
          type="button"
          className={tabClassName(directoryActive)}
          aria-pressed={directoryActive}
          onClick={() => onActiveTabChange("directory")}
        >
          {i18n.t("libraryDetail.directory")}
        </button>
        <button
          ref={sourceButtonRef}
          type="button"
          className="relative ml-auto flex min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors before:absolute before:-inset-y-1 before:inset-x-0 hover:text-foreground aria-expanded:text-foreground"
          aria-label={
            edition
              ? `${sourceTitle}: ${source.label}, ${editionTitle}: ${edition.label}`
              : `${sourceTitle}: ${source.label}`
          }
          aria-haspopup="dialog"
          aria-expanded={menuShown}
          title={`${source.label}: ${source.statusLabel}`}
          onClick={() => {
            if (!directoryActive) {
              onActiveTabChange("directory");
              changeMenuOpen(true);
              return;
            }
            changeMenuOpen(!menuOpen);
          }}
        >
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", sourceTabStatusClass(source.status))}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{source.label}</span>
          {edition && (
            <span className="shrink-0" aria-hidden="true">
              <span className="mr-1.5 text-muted-foreground/50">·</span>
              {edition.shortLabel}
            </span>
          )}
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none",
              menuShown && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
        {/* The name toggles draw no border or fill here, like the tabs and source
            beside them; a pressed toggle shows only by its primary-colored icon. */}
        <div
          ref={setToolsHost}
          className="flex shrink-0 items-center gap-1 empty:hidden [&_button]:relative [&_button]:border-0 [&_button]:bg-transparent! [&_button]:before:absolute [&_button]:before:-inset-1.5"
        />
      </div>
      <AnchoredPopover
        open={menuShown}
        anchorRef={sourceButtonRef}
        onOpenChange={changeMenuOpen}
        align="end"
        zIndex={70}
        ariaLabel={showingEditions ? editionTitle : sourceTitle}
        className={cn(
          "p-1 text-sm",
          showingEditions ? "w-[min(21rem,calc(100vw-1.5rem))]" : "w-[min(16rem,calc(100vw-1.5rem))]",
        )}
      >
        {edition && !showingEditions && (
          <button
            type="button"
            className="mb-1 flex min-h-11 w-full items-center gap-2 rounded-md border-b px-2 text-left hover:bg-muted"
            onClick={() => setEditionView(true)}
          >
            <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="shrink-0">{editionTitle}</span>
            <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{edition.label}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        )}
        {edition && showingEditions && (
          <div className="app-scroll max-h-[min(28rem,70vh)] overflow-y-auto">
            <div className="flex items-center gap-1 pb-1">
              <button
                type="button"
                className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={i18n.t("common.back")}
                title={i18n.t("common.back")}
                onClick={() => setEditionView(false)}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs font-medium text-muted-foreground">{editionTitle}</span>
            </div>
            <DirectoryEditionList model={edition} onClose={() => changeMenuOpen(false)} />
          </div>
        )}
        {/* The directory panel's sources stay mounted here while the edition list shows. */}
        <div ref={setMenuHost} hidden={showingEditions} />
      </AnchoredPopover>
      {directoryActive ? (
        <DirectoryTabMenuContext.Provider value={menu}>{directory}</DirectoryTabMenuContext.Provider>
      ) : (
        info
      )}
    </>
  );
}

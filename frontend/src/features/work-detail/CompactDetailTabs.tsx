import { ChevronDown } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import i18n from "@/i18n";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { cn } from "@/lib/tailwindClassNames";
import { DirectoryTabMenuContext } from "@/features/work-detail/directory/directoryTabMenu";
import { sourceTabStatusClass, type SourceTabInfo } from "@/features/work-detail/source/sourceContextModel";

/**
 * The Info and Directory switch of a compact detail, with the Directory's
 * source and name tools at the row's end. The source opens a popover where the
 * directory panel lists its sources; a phone has no source tab strip.
 */
export function CompactDetailTabs({
  activeTab,
  onActiveTabChange,
  source,
  info,
  directory,
}: {
  activeTab: "info" | "directory";
  onActiveTabChange: (tab: "info" | "directory") => void;
  /** The source the Directory and Source info show, by its short name. */
  source: { label: string; status: SourceTabInfo["status"]; statusLabel: string };
  info: ReactNode;
  directory: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
  const [toolsHost, setToolsHost] = useState<HTMLElement | null>(null);
  const sourceButtonRef = useRef<HTMLButtonElement | null>(null);
  const menu = useMemo(
    () => ({ host: menuHost, tools: toolsHost, close: () => setMenuOpen(false) }),
    [menuHost, toolsHost],
  );
  const directoryActive = activeTab === "directory";
  const menuShown = directoryActive && menuOpen;
  const sourceTitle = i18n.t("libraryDetail.directorySource");
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
          aria-label={`${sourceTitle}: ${source.label}`}
          aria-haspopup="dialog"
          aria-expanded={menuShown}
          title={`${source.label}: ${source.statusLabel}`}
          onClick={() => {
            if (!directoryActive) {
              onActiveTabChange("directory");
              setMenuOpen(true);
              return;
            }
            setMenuOpen((open) => !open);
          }}
        >
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", sourceTabStatusClass(source.status))}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{source.label}</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none",
              menuShown && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
        <div
          ref={setToolsHost}
          className="flex shrink-0 items-center gap-1 empty:hidden [&_button]:relative [&_button]:before:absolute [&_button]:before:-inset-1.5"
        />
      </div>
      <AnchoredPopover
        open={menuShown}
        anchorRef={sourceButtonRef}
        onOpenChange={setMenuOpen}
        align="end"
        zIndex={70}
        ariaLabel={sourceTitle}
        className="w-[min(16rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div ref={setMenuHost} />
      </AnchoredPopover>
      {directoryActive ? (
        <DirectoryTabMenuContext.Provider value={menu}>{directory}</DirectoryTabMenuContext.Provider>
      ) : (
        info
      )}
    </>
  );
}

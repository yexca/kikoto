import { ChevronDown } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import i18n from "@/i18n";
import { MobileSheet, MobileSheetBody } from "@/components/ui/mobile-sheet";
import { cn } from "@/lib/tailwindClassNames";
import { DirectoryTabMenuContext } from "@/features/work-detail/directory/directoryTabMenu";

/**
 * The Info and Directory switch of a compact detail. While Directory is shown,
 * its segment opens a sheet that holds the directory's source controls.
 */
export function CompactDetailTabs({
  activeTab,
  onActiveTabChange,
  info,
  directory,
}: {
  activeTab: "info" | "directory";
  onActiveTabChange: (tab: "info" | "directory") => void;
  info: ReactNode;
  directory: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
  const menu = useMemo(() => ({ host: menuHost, close: () => setMenuOpen(false) }), [menuHost]);
  const segmentClassName = (active: boolean) =>
    cn("min-h-10 rounded-md px-3 font-medium", active ? "bg-muted text-foreground" : "text-muted-foreground");
  const directoryActive = activeTab === "directory";
  const menuLabel = i18n.t("libraryDetail.sourceTabVisibility");

  return (
    <>
      <div className="grid grid-cols-2 rounded-lg border bg-card p-1 text-sm">
        <button className={segmentClassName(activeTab === "info")} onClick={() => onActiveTabChange("info")}>
          {i18n.t("libraryDetail.info")}
        </button>
        <div className={cn("flex min-w-0 rounded-md", directoryActive && "bg-muted")}>
          <button
            className={cn(
              segmentClassName(directoryActive),
              "min-w-0 flex-1 bg-transparent",
              directoryActive && "pl-10",
            )}
            onClick={() => onActiveTabChange("directory")}
          >
            {i18n.t("libraryDetail.directory")}
          </button>
          {directoryActive && (
            <button
              type="button"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background/60 hover:text-foreground"
              aria-label={menuLabel}
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              title={menuLabel}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", menuOpen && "rotate-180")}
              />
            </button>
          )}
        </div>
      </div>
      <MobileSheet open={directoryActive && menuOpen} onOpenChange={setMenuOpen} ariaLabel={menuLabel}>
        <MobileSheetBody className="text-sm">
          <div ref={setMenuHost} />
        </MobileSheetBody>
      </MobileSheet>
      {directoryActive ? (
        <DirectoryTabMenuContext.Provider value={menu}>{directory}</DirectoryTabMenuContext.Provider>
      ) : (
        info
      )}
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, MoreHorizontal } from "lucide-react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import i18n from "@/i18n";

/**
 * Current folder path with an up control. Compact layouts fold intermediate
 * ancestors into a menu; wide layouts show every bounded segment.
 */
export function DirectoryBreadcrumb({ path, onChange }: { path: string[]; onChange: (path: string[]) => void }) {
  const [ancestorMenuOpen, setAncestorMenuOpen] = useState(false);
  const ancestorMenuRef = useRef<HTMLButtonElement | null>(null);
  const segmentsRef = useRef<HTMLDivElement | null>(null);
  const current = path[path.length - 1] ?? "";
  const ancestors = path.slice(0, -1);

  useEffect(() => {
    setAncestorMenuOpen(false);
    // A long path scrolls; keep the current folder in view rather than the root.
    const segments = segmentsRef.current;
    if (segments) segments.scrollLeft = segments.scrollWidth;
  }, [path]);

  return (
    <nav
      data-testid="directory-breadcrumb"
      className="flex min-h-9 min-w-0 flex-1 items-center gap-0.5 rounded-md bg-muted/50 px-1 text-sm"
      aria-label={i18n.t("libraryDetail.parentFolder")}
    >
      <button
        type="button"
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
        aria-label={i18n.t("libraryDetail.parentFolder")}
        title={i18n.t("libraryDetail.parentFolder")}
        disabled={path.length === 0}
        onClick={() => onChange(path.slice(0, -1))}
      >
        <CornerLeftUp className="h-4 w-4" />
      </button>
      <div className="flex min-h-9 min-w-0 flex-1 items-center gap-1 overflow-hidden lg:hidden">
        <button className="shrink-0 rounded px-2 py-1 font-medium hover:bg-background" onClick={() => onChange([])}>
          {i18n.t("libraryDetail.root")}
        </button>
        {path.length > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        {ancestors.length > 0 && (
          <>
            <button
              ref={ancestorMenuRef}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setAncestorMenuOpen((open) => !open)}
              aria-label={i18n.t("libraryDetail.showParentFolders", { count: ancestors.length })}
              aria-haspopup="menu"
              aria-expanded={ancestorMenuOpen}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <AnchoredPopover
              open={ancestorMenuOpen}
              anchorRef={ancestorMenuRef}
              onOpenChange={setAncestorMenuOpen}
              className="w-[min(20rem,calc(100vw-1.5rem))] p-1"
              bottomCollisionPadding={96}
            >
              <div role="menu" aria-label={i18n.t("libraryDetail.parentFolder")}>
                {ancestors.map((part, index) => (
                  <button
                    key={`${part}:${index}`}
                    role="menuitem"
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                    title={part}
                    onClick={() => onChange(path.slice(0, index + 1))}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{part}</span>
                  </button>
                ))}
              </div>
            </AnchoredPopover>
          </>
        )}
        {current && (
          <span
            data-testid="directory-breadcrumb-current"
            className="min-w-0 max-w-[55vw] truncate rounded px-2 py-1 font-semibold sm:max-w-[20rem]"
            title={current}
            aria-current="page"
          >
            {current}
          </span>
        )}
      </div>

      <div
        ref={segmentsRef}
        className="app-scrollbar hidden min-h-9 min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap lg:flex"
      >
        <button className="shrink-0 rounded px-2 py-1 font-medium hover:bg-background" onClick={() => onChange([])}>
          {i18n.t("libraryDetail.root")}
        </button>
        {path.map((part, index) => {
          const isCurrent = index === path.length - 1;
          return (
            <span key={`${part}:${index}`} className="inline-flex min-w-0 shrink-0 items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {isCurrent ? (
                <span
                  className="block max-w-[20rem] truncate rounded px-2 py-1 font-semibold"
                  title={part}
                  aria-current="page"
                >
                  {part}
                </span>
              ) : (
                <button
                  className="block max-w-[18rem] truncate rounded px-2 py-1 text-left font-medium text-muted-foreground hover:bg-background hover:text-foreground"
                  title={part}
                  onClick={() => onChange(path.slice(0, index + 1))}
                >
                  {part}
                </button>
              )}
            </span>
          );
        })}
      </div>
    </nav>
  );
}

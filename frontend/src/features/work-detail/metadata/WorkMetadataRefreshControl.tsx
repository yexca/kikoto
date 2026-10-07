import { ChevronDown, Cloud, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import type { LibrarySource } from "@/lib/api";
import { librarySourceProvidesMetadata } from "@/lib/remoteSourceCapabilities";

/** The usual refresh plus explicit, metadata-only refreshes from configured remote sources. */
export function WorkMetadataRefreshControl({
  sources,
  busy,
  disabled,
  onRefresh,
}: {
  sources: LibrarySource[];
  busy: boolean;
  disabled: boolean;
  onRefresh: (sourceId?: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const remoteSources = sources.filter((source) => source.enabled && librarySourceProvidesMetadata(source));
  const locked = disabled || busy;

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("button")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const close = () => {
    setOpen(false);
    anchorRef.current?.focus();
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="flex shrink-0 items-center">
      <Button
        variant="outline"
        size="sm"
        className={`h-11 sm:h-8 ${remoteSources.length ? "rounded-r-none" : ""}`}
        disabled={locked}
        onClick={() => onRefresh()}
      >
        <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
        {t(busy ? "detailActions.metadataRefreshRunning" : "detailActions.refreshMetadata")}
      </Button>
      {remoteSources.length > 0 && (
        <>
          <Button
            ref={anchorRef}
            variant="outline"
            size="icon"
            className="-ml-px h-11 w-11 rounded-l-none sm:h-8 sm:w-8"
            disabled={locked}
            aria-label={t("detailActions.metadataRefreshSources")}
            title={t("detailActions.metadataRefreshSources")}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <AnchoredPopover
            open={open}
            anchorRef={anchorRef}
            onOpenChange={(nextOpen) => {
              if (nextOpen) setOpen(true);
              else close();
            }}
            floatingLayer
            className="w-64 p-1"
            zIndex={70}
          >
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={t("detailActions.metadataRefreshSources")}
              onKeyDown={onMenuKeyDown}
            >
              {remoteSources.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={locked}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50"
                  onClick={() => {
                    close();
                    onRefresh(source.id);
                  }}
                >
                  <Cloud className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">
                    {t("detailActions.refreshMetadataFrom", { source: source.displayName })}
                  </span>
                </button>
              ))}
            </div>
          </AnchoredPopover>
        </>
      )}
    </div>
  );
}

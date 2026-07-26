import { Columns3, LayoutGrid, PanelsTopLeft } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import {
  isWorkCollectionColumnCount,
  workCollectionColumnOptions,
  type WorkCollectionColumnSetting,
  type WorkCollectionViewMode,
} from "@/components/work-collection/workCollectionLayoutModel";

export {
  workCollectionClassName,
  workCollectionColumnOptions,
  workCollectionItemClassName,
  workCollectionStyle,
} from "@/components/work-collection/workCollectionLayoutModel";
export type {
  WorkCollectionColumnCount,
  WorkCollectionColumnSetting,
  WorkCollectionViewMode,
} from "@/components/work-collection/workCollectionLayoutModel";

const layoutStorageKey = "kikoto:work-collection-layout";
const layoutChangeEvent = "kikoto:work-collection-layout-change";

type StoredWorkCollectionLayout = {
  viewMode: WorkCollectionViewMode;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
};

export function useWorkCollectionLayout(
  initial: StoredWorkCollectionLayout = { viewMode: "grid", mobileColumns: "auto", desktopColumns: "auto" },
) {
  const [layout, setLayout] = useState<StoredWorkCollectionLayout>(() => readStoredLayout(initial));
  useEffect(() => {
    const sync = () => setLayout(readStoredLayout(initial));
    window.addEventListener("storage", sync);
    window.addEventListener(layoutChangeEvent, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(layoutChangeEvent, sync);
    };
  }, [initial.desktopColumns, initial.mobileColumns, initial.viewMode]);
  const update = (patch: Partial<StoredWorkCollectionLayout>) => {
    setLayout((current) => {
      const next = { ...current, ...patch };
      localStorage.setItem(layoutStorageKey, JSON.stringify(next));
      window.dispatchEvent(new Event(layoutChangeEvent));
      return next;
    });
  };
  return {
    ...layout,
    setViewMode: (viewMode: WorkCollectionViewMode) => update({ viewMode }),
    setMobileColumns: (mobileColumns: WorkCollectionColumnSetting) => update({ mobileColumns }),
    setDesktopColumns: (desktopColumns: WorkCollectionColumnSetting) => update({ desktopColumns }),
  };
}

export function WorkCollectionLayoutPicker({
  viewMode,
  mobileColumns,
  desktopColumns,
  onViewModeChange,
  onMobileColumnsChange,
  onDesktopColumnsChange,
}: {
  viewMode: WorkCollectionViewMode;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  onViewModeChange: (value: WorkCollectionViewMode) => void;
  onMobileColumnsChange: (value: WorkCollectionColumnSetting) => void;
  onDesktopColumnsChange: (value: WorkCollectionColumnSetting) => void;
}) {
  const [viewOpen, setViewOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const isWide = useIsWideLayout();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useDismissiblePopover(viewOpen || columnsOpen, popoverRef, () => {
    setViewOpen(false);
    setColumnsOpen(false);
  });
  const currentValue = isWide ? desktopColumns : mobileColumns;
  const options: readonly WorkCollectionColumnSetting[] = isWide
    ? ["auto", ...workCollectionColumnOptions]
    : ["auto", 1, 2];
  const ActiveViewIcon = viewMode === "masonry" ? PanelsTopLeft : LayoutGrid;
  const setColumns = (value: WorkCollectionColumnSetting) => {
    if (isWide) onDesktopColumnsChange(value);
    else onMobileColumnsChange(value);
    setColumnsOpen(false);
  };

  return (
    <div className="relative" ref={popoverRef}>
      <div className="inline-flex rounded-md border bg-background">
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-l-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title={`View: ${viewMode === "masonry" ? "Masonry" : "Grid"}`}
          aria-label={`View: ${viewMode === "masonry" ? "Masonry" : "Grid"}`}
          type="button"
          onClick={() => {
            setViewOpen((current) => !current);
            setColumnsOpen(false);
          }}
        >
          <ActiveViewIcon className="h-4 w-4" />
        </button>
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-r-md border-l text-muted-foreground hover:bg-muted hover:text-foreground"
          title={`Columns: ${columnSettingLabel(currentValue)}`}
          aria-label={`Columns: ${columnSettingLabel(currentValue)}`}
          type="button"
          onClick={() => {
            setColumnsOpen((current) => !current);
            setViewOpen(false);
          }}
        >
          <Columns3 className="h-4 w-4" />
        </button>
      </div>
      <AnchoredPopover open={viewOpen} anchorRef={popoverRef} onOpenChange={setViewOpen} className="w-36 p-1 text-sm">
        {[
          { value: "grid" as const, label: "Grid", icon: LayoutGrid },
          { value: "masonry" as const, label: "Masonry", icon: PanelsTopLeft },
        ].map((option) => (
          <button
            key={option.value}
            type="button"
            className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted ${viewMode === option.value ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
            aria-pressed={viewMode === option.value}
            onClick={() => {
              onViewModeChange(option.value);
              setViewOpen(false);
            }}
          >
            <option.icon className="h-4 w-4" />
            <span>{option.label}</span>
          </button>
        ))}
      </AnchoredPopover>
      <AnchoredPopover
        open={columnsOpen}
        anchorRef={popoverRef}
        onOpenChange={setColumnsOpen}
        className="flex w-16 flex-col gap-1 p-1 text-sm"
      >
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`flex h-8 items-center justify-center rounded-md text-sm font-medium hover:bg-muted ${currentValue === option ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
            aria-pressed={currentValue === option}
            title={columnOptionLabel(option)}
            aria-label={columnOptionLabel(option)}
            onClick={() => setColumns(option)}
          >
            {columnSettingLabel(option)}
          </button>
        ))}
      </AnchoredPopover>
    </div>
  );
}

function useDismissiblePopover(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open, ref]);
}

function useIsWideLayout() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

function columnSettingLabel(setting: WorkCollectionColumnSetting) {
  return setting === "auto" ? "Auto" : String(setting);
}

function columnOptionLabel(setting: WorkCollectionColumnSetting) {
  if (setting === "auto") return "Automatic columns";
  return `${setting} ${setting === 1 ? "column" : "columns"}`;
}

function readStoredLayout(fallback: StoredWorkCollectionLayout): StoredWorkCollectionLayout {
  try {
    const value = JSON.parse(localStorage.getItem(layoutStorageKey) ?? "{}") as Partial<StoredWorkCollectionLayout>;
    return {
      viewMode: value.viewMode === "masonry" ? "masonry" : value.viewMode === "grid" ? "grid" : fallback.viewMode,
      mobileColumns:
        value.mobileColumns === "auto" || value.mobileColumns === 1 || value.mobileColumns === 2
          ? value.mobileColumns
          : fallback.mobileColumns,
      desktopColumns:
        value.desktopColumns === "auto" || isWorkCollectionColumnCount(value.desktopColumns)
          ? value.desktopColumns
          : fallback.desktopColumns,
    };
  } catch {
    return fallback;
  }
}

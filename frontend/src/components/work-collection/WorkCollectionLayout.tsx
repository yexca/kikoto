import { Columns3, LayoutGrid, PanelsTopLeft } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";

export const workCollectionColumnOptions = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type WorkCollectionColumnCount = (typeof workCollectionColumnOptions)[number];
export type WorkCollectionViewMode = "grid" | "masonry";

const layoutStorageKey = "kikoto:work-collection-layout";
const layoutChangeEvent = "kikoto:work-collection-layout-change";

type StoredWorkCollectionLayout = {
  viewMode: WorkCollectionViewMode;
  mobileColumns: WorkCollectionColumnCount;
  desktopColumns: WorkCollectionColumnCount;
};

export function useWorkCollectionLayout(initial: StoredWorkCollectionLayout = { viewMode: "grid", mobileColumns: 2, desktopColumns: 6 }) {
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
    setMobileColumns: (mobileColumns: WorkCollectionColumnCount) => update({ mobileColumns }),
    setDesktopColumns: (desktopColumns: WorkCollectionColumnCount) => update({ desktopColumns }),
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
  mobileColumns: WorkCollectionColumnCount;
  desktopColumns: WorkCollectionColumnCount;
  onViewModeChange: (value: WorkCollectionViewMode) => void;
  onMobileColumnsChange: (value: WorkCollectionColumnCount) => void;
  onDesktopColumnsChange: (value: WorkCollectionColumnCount) => void;
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
  const options = isWide ? workCollectionColumnOptions : ([1, 2] as const);
  const ActiveViewIcon = viewMode === "masonry" ? PanelsTopLeft : LayoutGrid;
  const setColumns = (value: WorkCollectionColumnCount) => {
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
          onClick={() => {
            setViewOpen((current) => !current);
            setColumnsOpen(false);
          }}
        >
          <ActiveViewIcon className="h-4 w-4" />
        </button>
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-r-md border-l text-muted-foreground hover:bg-muted hover:text-foreground"
          title={`Columns: ${currentValue}`}
          aria-label={`Columns: ${currentValue}`}
          onClick={() => {
            setColumnsOpen((current) => !current);
            setViewOpen(false);
          }}
        >
          <Columns3 className="h-4 w-4" />
        </button>
      </div>
      <AnchoredPopover open={viewOpen} anchorRef={popoverRef} onOpenChange={setViewOpen} className="w-36 p-1 text-sm">
        {([
          { value: "grid" as const, label: "Grid", icon: LayoutGrid },
          { value: "masonry" as const, label: "Masonry", icon: PanelsTopLeft },
        ]).map((option) => (
          <button
            key={option.value}
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
      <AnchoredPopover open={columnsOpen} anchorRef={popoverRef} onOpenChange={setColumnsOpen} className="flex w-10 flex-col gap-1 p-1 text-sm">
        {options.map((option) => (
          <button
            key={option}
            className={`flex h-8 items-center justify-center rounded-md text-sm font-medium hover:bg-muted ${currentValue === option ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
            aria-pressed={currentValue === option}
            title={`${option} ${option === 1 ? "column" : "columns"}`}
            aria-label={`${option} ${option === 1 ? "column" : "columns"}`}
            onClick={() => setColumns(option)}
          >
            {option}
          </button>
        ))}
      </AnchoredPopover>
    </div>
  );
}

export function workCollectionClassName(viewMode: WorkCollectionViewMode) {
  return viewMode === "masonry"
    ? "[column-count:var(--mobile-columns)] [column-gap:1rem] sm:[column-count:var(--desktop-columns)]"
    : "grid gap-4 [grid-template-columns:repeat(var(--mobile-columns),minmax(0,1fr))] sm:[grid-template-columns:repeat(var(--desktop-columns),minmax(0,1fr))]";
}

export function workCollectionStyle(mobileColumns: WorkCollectionColumnCount, desktopColumns: WorkCollectionColumnCount) {
  return {
    "--mobile-columns": mobileColumns,
    "--desktop-columns": desktopColumns,
  } as CSSProperties;
}

export function workCollectionItemClassName(viewMode: WorkCollectionViewMode) {
  return viewMode === "masonry" ? "mb-4 [break-inside:avoid]" : "";
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
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 640px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 640px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

function readStoredLayout(fallback: StoredWorkCollectionLayout): StoredWorkCollectionLayout {
  try {
    const value = JSON.parse(localStorage.getItem(layoutStorageKey) ?? "{}") as Partial<StoredWorkCollectionLayout>;
    return {
      viewMode: value.viewMode === "masonry" ? "masonry" : value.viewMode === "grid" ? "grid" : fallback.viewMode,
      mobileColumns: value.mobileColumns === 1 || value.mobileColumns === 2 ? value.mobileColumns : fallback.mobileColumns,
      desktopColumns: workCollectionColumnOptions.includes(value.desktopColumns as WorkCollectionColumnCount)
        ? value.desktopColumns as WorkCollectionColumnCount
        : fallback.desktopColumns,
    };
  } catch {
    return fallback;
  }
}

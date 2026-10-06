import { Columns3Cog } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import i18n from "@/i18n";
import { cn } from "@/lib/tailwindClassNames";
import {
  isWorkCollectionDesktopColumnSetting,
  isWorkCollectionMobileColumnSetting,
  workCollectionDesktopColumnOptions,
  workCollectionMobileColumnOptions,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/workCollectionLayoutModel";

export {
  workCollectionClassName,
  workCollectionColumnOptions,
  workCollectionStyle,
} from "@/components/work-collection/workCollectionLayoutModel";
export type {
  WorkCollectionColumnCount,
  WorkCollectionColumnSetting,
} from "@/components/work-collection/workCollectionLayoutModel";

const layoutStorageKey = "kikoto:work-collection-layout";
const layoutChangeEvent = "kikoto:work-collection-layout-change";

type StoredWorkCollectionLayout = {
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
};

export function useWorkCollectionLayout(
  initial: StoredWorkCollectionLayout = { mobileColumns: "auto", desktopColumns: "auto" },
) {
  const [layout, setLayout] = useState<StoredWorkCollectionLayout>(() => readStoredLayout(initial));
  // Callers may pass a fresh default object each render; subscribe on its values.
  const { mobileColumns: initialMobileColumns, desktopColumns: initialDesktopColumns } = initial;
  useEffect(() => {
    const sync = () =>
      setLayout(readStoredLayout({ mobileColumns: initialMobileColumns, desktopColumns: initialDesktopColumns }));
    window.addEventListener("storage", sync);
    window.addEventListener(layoutChangeEvent, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(layoutChangeEvent, sync);
    };
  }, [initialDesktopColumns, initialMobileColumns]);
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
    setMobileColumns: (mobileColumns: WorkCollectionColumnSetting) => update({ mobileColumns }),
    setDesktopColumns: (desktopColumns: WorkCollectionColumnSetting) => update({ desktopColumns }),
  };
}

/**
 * One toolbar control for how a work collection is displayed: grid columns and
 * items per page share a popover so the toolbar spends a single icon on them.
 * Either group may be omitted (a list view has no columns; some collections are
 * not paged). The popover stays open after a choice so both can be adjusted.
 */
export function WorkCollectionDisplayPicker({
  mobileColumns,
  desktopColumns,
  onMobileColumnsChange,
  onDesktopColumnsChange,
  showColumns = true,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
}: {
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  onMobileColumnsChange: (value: WorkCollectionColumnSetting) => void;
  onDesktopColumnsChange: (value: WorkCollectionColumnSetting) => void;
  showColumns?: boolean;
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (value: number) => void;
}) {
  const { t } = useTranslation("translation", { i18n });
  const [open, setOpen] = useState(false);
  const isWide = useIsWideLayout();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const currentColumns = isWide ? desktopColumns : mobileColumns;
  const columnOptions: readonly WorkCollectionColumnSetting[] = [
    "auto",
    ...(isWide ? workCollectionDesktopColumnOptions : workCollectionMobileColumnOptions),
  ];
  const setColumns = (value: WorkCollectionColumnSetting) => {
    if (isWide) onDesktopColumnsChange(value);
    else onMobileColumnsChange(value);
  };
  const paged = pageSize !== undefined && pageSizeOptions !== undefined && onPageSizeChange !== undefined;
  const summary = [
    showColumns ? t("collection.columns", { label: columnSettingLabel(currentColumns, t) }) : null,
    paged ? t("collection.pageSize", { value: pageSize }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const buttonLabel = t("collection.displayOptionsValue", { value: summary });

  return (
    <div className="relative" ref={anchorRef}>
      <Button
        variant="toolbar"
        size="icon-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative"
        title={buttonLabel}
        aria-label={buttonLabel}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <Columns3Cog className="h-4 w-4" />
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        ariaLabel={t("collection.displayOptions")}
        className="flex w-[min(18rem,calc(100vw-1.5rem))] flex-col gap-3 p-3 text-sm"
      >
        {showColumns && (
          <DisplayOptionGroup label={t("collection.columnsHeading")}>
            {columnOptions.map((option) => (
              <DisplayOptionButton
                key={option}
                checked={currentColumns === option}
                label={columnOptionLabel(option, t)}
                className={option === "auto" ? "flex-[1.6]" : undefined}
                onSelect={() => setColumns(option)}
              >
                {columnSettingLabel(option, t)}
              </DisplayOptionButton>
            ))}
          </DisplayOptionGroup>
        )}
        {paged && (
          <DisplayOptionGroup label={t("collection.itemsPerPage")}>
            {pageSizeOptions.map((option) => (
              <DisplayOptionButton
                key={option}
                checked={pageSize === option}
                label={t("collection.perPageOption", { value: option })}
                onSelect={() => onPageSizeChange(option)}
              >
                {option}
              </DisplayOptionButton>
            ))}
          </DisplayOptionGroup>
        )}
      </AnchoredPopover>
    </div>
  );
}

function DisplayOptionGroup({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div id={labelId} className="px-0.5 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className={segmentedListClassName("w-full")}>
        {children}
      </div>
    </div>
  );
}

function DisplayOptionButton({
  checked,
  label,
  className,
  onSelect,
  children,
}: {
  checked: boolean;
  label: string;
  className?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      title={label}
      aria-label={label}
      className={segmentedItemClassName(checked, cn("min-w-0 flex-1 justify-center px-0 tabular-nums", className))}
      onClick={onSelect}
    >
      {children}
    </button>
  );
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

function columnSettingLabel(setting: WorkCollectionColumnSetting, t: TFunction<"translation">) {
  return setting === "auto" ? t("collection.auto") : String(setting);
}

function columnOptionLabel(setting: WorkCollectionColumnSetting, t: TFunction<"translation">) {
  if (setting === "auto") return t("collection.automaticColumns");
  return t("collection.column", { count: setting });
}

function readStoredLayout(fallback: StoredWorkCollectionLayout): StoredWorkCollectionLayout {
  try {
    const value = JSON.parse(localStorage.getItem(layoutStorageKey) ?? "{}") as Partial<StoredWorkCollectionLayout>;
    return {
      mobileColumns: isWorkCollectionMobileColumnSetting(value.mobileColumns)
        ? value.mobileColumns
        : fallback.mobileColumns,
      // Desktop no longer offers one or two columns; an older choice reverts to the default.
      desktopColumns: isWorkCollectionDesktopColumnSetting(value.desktopColumns)
        ? value.desktopColumns
        : isWorkCollectionDesktopColumnSetting(fallback.desktopColumns)
          ? fallback.desktopColumns
          : "auto",
    };
  } catch {
    return fallback;
  }
}

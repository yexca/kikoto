import { ListChecks, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { CollectionFilterPicker, type CollectionFilterOption } from "@/components/collection/CollectionFilterPicker";
import { PageSizePicker } from "@/components/collection/PageSizePicker";
import { Button } from "@/components/ui/button";
import {
  WorkCollectionLayoutPicker,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";

/**
 * First-row toolbar for the works of one circle or voice actor. It mirrors the
 * Library and creator-list toolbars: optional view tabs on the left, a bounded
 * search field, and quiet icon actions (columns, page size, availability
 * filter, selection) on the right. Narrow layouts keep their options sheet, so
 * the search and actions stay desktop-only unless `mobileSearch` opts in.
 */
export function CatalogWorkToolbar<FilterValue extends string>({
  leading,
  query,
  searchLabel,
  mobileSearch = false,
  mobileSearchAction,
  onQueryChange,
  filterLabel,
  filter,
  defaultFilter,
  filterOptions,
  onFilterChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  mobileColumns,
  desktopColumns,
  onMobileColumnsChange,
  onDesktopColumnsChange,
  selectionMode,
  onSelectionModeChange,
}: {
  leading?: ReactNode;
  query: string;
  searchLabel: string;
  mobileSearch?: boolean;
  mobileSearchAction?: ReactNode;
  onQueryChange: (value: string) => void;
  filterLabel: string;
  filter: FilterValue;
  defaultFilter: FilterValue;
  filterOptions: readonly CollectionFilterOption<FilterValue>[];
  onFilterChange: (value: FilterValue) => void;
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (value: number) => void;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  onMobileColumnsChange: (value: WorkCollectionColumnSetting) => void;
  onDesktopColumnsChange: (value: WorkCollectionColumnSetting) => void;
  selectionMode?: boolean;
  onSelectionModeChange?: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const visibleOnMobile = Boolean(leading) || mobileSearch;
  const selectionLabel = selectionMode ? t("library.cancelSelection") : t("library.select");

  return (
    <section className={`${visibleOnMobile ? "flex" : "hidden lg:flex"} flex-wrap items-center gap-2`} data-toast-avoid>
      {leading && <div className="min-w-0 max-w-full">{leading}</div>}
      <div
        className={`search-field min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:flex lg:w-auto lg:min-w-[14rem] lg:max-w-xl lg:flex-1 ${
          mobileSearch ? "flex" : "hidden"
        }`}
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          value={query}
          onKeyDown={dismissKeyboardOnEnter}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
        />
        {query.trim() && (
          <button
            type="button"
            className="rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onQueryChange("")}
            aria-label={t("collection.clearSearch")}
            title={t("collection.clearSearch")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {mobileSearchAction && <div className="-mr-1.5 shrink-0 lg:hidden">{mobileSearchAction}</div>}
      </div>
      <div className="ml-auto hidden shrink-0 gap-2 lg:flex">
        <WorkCollectionLayoutPicker
          mobileColumns={mobileColumns}
          desktopColumns={desktopColumns}
          onMobileColumnsChange={onMobileColumnsChange}
          onDesktopColumnsChange={onDesktopColumnsChange}
        />
        {pageSize !== undefined && pageSizeOptions && onPageSizeChange && (
          <PageSizePicker value={pageSize} options={pageSizeOptions} onChange={onPageSizeChange} />
        )}
        <CollectionFilterPicker
          label={filterLabel}
          value={filter}
          defaultValue={defaultFilter}
          options={filterOptions}
          onChange={onFilterChange}
        />
        {onSelectionModeChange && (
          <Button
            type="button"
            variant="toolbar"
            size="icon-sm"
            className="relative"
            aria-pressed={Boolean(selectionMode)}
            title={selectionLabel}
            aria-label={selectionLabel}
            onClick={() => onSelectionModeChange(!selectionMode)}
          >
            <ListChecks className={`h-4 w-4 ${selectionMode ? "text-primary" : ""}`} />
          </Button>
        )}
      </div>
    </section>
  );
}

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { CollectionFilterPicker, type CollectionFilterOption } from "@/components/collection/CollectionFilterPicker";
import { PageSizePicker } from "@/components/collection/PageSizePicker";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { useTranslation } from "react-i18next";

export type CreatorListToolbarFilterOption<Value extends string> = CollectionFilterOption<Value>;

export function CreatorListToolbar<FilterValue extends string>({
  label,
  query,
  placeholder,
  filter,
  defaultFilter,
  filterOptions,
  pageSize,
  pageSizeOptions,
  onQueryChange,
  onFilterChange,
  onPageSizeChange,
}: {
  label: string;
  query: string;
  placeholder: string;
  filter: FilterValue;
  defaultFilter: FilterValue;
  filterOptions: readonly CreatorListToolbarFilterOption<FilterValue>[];
  pageSize: number;
  pageSizeOptions: readonly number[];
  onQueryChange: (value: string) => void;
  onFilterChange: (value: FilterValue) => void;
  onPageSizeChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const mobileNavigationLayout = useMobileNavigationLayout();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(() => Boolean(query.trim()));
  const mobileSearchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (query.trim()) setMobileSearchOpen(true);
  }, [query]);

  useEffect(() => {
    if (!mobileNavigationLayout || !mobileSearchOpen) return;
    const frame = window.requestAnimationFrame(() => mobileSearchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mobileNavigationLayout, mobileSearchOpen]);

  return (
    <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between" data-toast-avoid>
      <div
        className={`search-field order-2 min-h-10 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:order-1 lg:flex lg:max-w-xl ${
          mobileSearchOpen ? "flex" : "hidden"
        }`}
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={mobileSearchInputRef}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          value={query}
          onKeyDown={dismissKeyboardOnEnter}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        {query.trim() && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onQueryChange("")}
            aria-label={t("collection.clearSearch")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="order-1 flex w-full flex-wrap justify-end gap-2 lg:order-2 lg:w-auto">
        {mobileNavigationLayout && (
          <CreatorListToolbarIconButton
            title={
              query.trim()
                ? t("collection.searchActive", { label })
                : mobileSearchOpen
                  ? t("collection.hideSearch", { label })
                  : t("collection.search", { label })
            }
            disabled={Boolean(query.trim())}
            onClick={() => {
              if (mobileSearchOpen && !query.trim()) {
                setMobileSearchOpen(false);
                return;
              }
              setMobileSearchOpen(true);
            }}
          >
            <Search className="h-4 w-4" />
          </CreatorListToolbarIconButton>
        )}
        <PageSizePicker value={pageSize} options={pageSizeOptions} onChange={onPageSizeChange} />
        <CollectionFilterPicker
          label={t("collection.filters", { label })}
          value={filter}
          defaultValue={defaultFilter}
          options={filterOptions}
          onChange={onFilterChange}
        />
      </div>
    </section>
  );
}

function CreatorListToolbarIconButton({
  title,
  disabled,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="toolbar"
      size="icon-sm"
      className="relative disabled:pointer-events-none disabled:opacity-50"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

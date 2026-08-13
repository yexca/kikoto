import { Filter, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { PageSizePicker } from "@/components/collection/PageSizePicker";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";

export type CreatorListToolbarFilterOption<Value extends string> = {
  value: Value;
  label: string;
};

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
        className={`order-2 min-h-10 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:order-1 lg:flex lg:max-w-xl ${
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
            aria-label="Clear search"
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
                ? `${label} search is active`
                : mobileSearchOpen
                  ? `Hide ${label.toLowerCase()} search`
                  : `Search ${label.toLowerCase()}`
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
        <CreatorListFilterPicker
          label={label}
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
    <button
      type="button"
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CreatorListFilterPicker<FilterValue extends string>({
  label,
  value,
  defaultValue,
  options,
  onChange,
}: {
  label: string;
  value: FilterValue;
  defaultValue: FilterValue;
  options: readonly CreatorListToolbarFilterOption<FilterValue>[];
  onChange: (value: FilterValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? "Filter";
  const active = value !== defaultValue;

  return (
    <div className="relative" ref={anchorRef}>
      <CreatorListToolbarIconButton
        title={active ? `${label} filter: ${selectedLabel}` : selectedLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <Filter className="h-4 w-4" />
        {active && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />}
      </CreatorListToolbarIconButton>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        className="w-[min(13rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={`${label} filters`}>
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-foreground">
            <Filter className="h-4 w-4" />
            <span>Filter</span>
          </div>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === option.value}
              className={`flex min-h-10 w-full items-center rounded-md px-3 py-2 text-left hover:bg-muted ${value === option.value ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

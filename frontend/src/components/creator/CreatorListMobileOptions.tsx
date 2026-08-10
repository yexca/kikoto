import { ArrowLeft, Check, ChevronRight, Filter, ListMusic, SlidersHorizontal, Tags, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";

export type CreatorListFilterOption<Value extends string> = {
  value: Value;
  label: string;
};

type CreatorListMobilePanel = "root" | "filter" | "tag" | "page-size";

export function CreatorListMobileOptions<FilterValue extends string>({
  label,
  filter,
  defaultFilter,
  filterOptions,
  tag,
  tagOptions,
  pageSize,
  pageSizeOptions,
  onFilterChange,
  onTagChange,
  onPageSizeChange,
}: {
  label: string;
  filter: FilterValue;
  defaultFilter: FilterValue;
  filterOptions: readonly CreatorListFilterOption<FilterValue>[];
  tag?: string;
  tagOptions?: readonly string[];
  pageSize: number;
  pageSizeOptions: readonly number[];
  onFilterChange: (value: FilterValue) => void;
  onTagChange?: (value: string) => void;
  onPageSizeChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<CreatorListMobilePanel>("root");
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const hasTagFilter = tagOptions !== undefined && onTagChange !== undefined;
  const activeFilterCount = Number(filter !== defaultFilter) + Number(Boolean(tag));
  const filterLabel = filterOptions.find((option) => option.value === filter)?.label ?? "Filter";
  const tagLabel = tag || "All tags";

  const setPopoverOpen = (value: boolean) => {
    setOpen(value);
    if (!value) setPanel("root");
  };
  const runAndClose = (action: () => void) => {
    action();
    setPopoverOpen(false);
  };
  const clearFilters = () => {
    onFilterChange(defaultFilter);
    onTagChange?.("");
    setPopoverOpen(false);
  };

  return (
    <div className="relative" ref={anchorRef}>
      <Button
        variant="outline"
        size="icon"
        className="relative h-11 w-11"
        onClick={() => setPopoverOpen(!open)}
        aria-label={`${label} list options${activeFilterCount > 0 ? `, ${activeFilterCount} active filters` : ""}`}
        title={`${label} list options`}
      >
        <SlidersHorizontal className="h-4 w-4" />
        {activeFilterCount > 0 && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />
        )}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setPopoverOpen}
        className="w-[min(19rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        {panel === "root" ? (
          <div role="menu" aria-label={`${label} list options`}>
            <div className="px-3 py-2 text-xs font-semibold text-foreground">List options</div>
            <CreatorListMobileMenuRow
              icon={<Filter className="h-4 w-4" />}
              label="Filter"
              value={filterLabel}
              onClick={() => setPanel("filter")}
            />
            {hasTagFilter && (
              <CreatorListMobileMenuRow
                icon={<Tags className="h-4 w-4" />}
                label="Tag"
                value={tagLabel}
                onClick={() => setPanel("tag")}
              />
            )}
            <CreatorListMobileMenuRow
              icon={<ListMusic className="h-4 w-4" />}
              label="Per page"
              value={String(pageSize)}
              onClick={() => setPanel("page-size")}
            />
            {activeFilterCount > 0 && (
              <CreatorListMobileMenuRow
                icon={<X className="h-4 w-4" />}
                label="Clear filters"
                value=""
                trailing={false}
                onClick={clearFilters}
              />
            )}
          </div>
        ) : (
          <CreatorListMobileOptionPanel
            panel={panel}
            filter={filter}
            filterOptions={filterOptions}
            tag={tag ?? ""}
            tagOptions={tagOptions ?? []}
            pageSize={pageSize}
            pageSizeOptions={pageSizeOptions}
            onBack={() => setPanel("root")}
            onFilterChange={(value) => runAndClose(() => onFilterChange(value))}
            onTagChange={(value) => runAndClose(() => onTagChange?.(value))}
            onPageSizeChange={(value) => runAndClose(() => onPageSizeChange(value))}
          />
        )}
      </AnchoredPopover>
    </div>
  );
}

function CreatorListMobileMenuRow({
  icon,
  label,
  value,
  trailing = true,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  trailing?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={onClick}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 text-foreground">{label}</span>
      {value && <span className="max-w-28 truncate text-xs">{value}</span>}
      {trailing && <ChevronRight className="h-4 w-4 shrink-0" />}
    </button>
  );
}

function CreatorListMobileOptionPanel<FilterValue extends string>({
  panel,
  filter,
  filterOptions,
  tag,
  tagOptions,
  pageSize,
  pageSizeOptions,
  onBack,
  onFilterChange,
  onTagChange,
  onPageSizeChange,
}: {
  panel: Exclude<CreatorListMobilePanel, "root">;
  filter: FilterValue;
  filterOptions: readonly CreatorListFilterOption<FilterValue>[];
  tag: string;
  tagOptions: readonly string[];
  pageSize: number;
  pageSizeOptions: readonly number[];
  onBack: () => void;
  onFilterChange: (value: FilterValue) => void;
  onTagChange: (value: string) => void;
  onPageSizeChange: (value: number) => void;
}) {
  const title = panel === "filter" ? "Filter" : panel === "tag" ? "Tag" : "Per page";
  const selectedTagOptions = tag && !tagOptions.includes(tag) ? [tag, ...tagOptions] : tagOptions;
  const options =
    panel === "filter"
      ? filterOptions.map((option) => ({
          key: option.value,
          label: option.label,
          selected: option.value === filter,
          select: () => onFilterChange(option.value),
        }))
      : panel === "tag"
        ? ["", ...selectedTagOptions].map((option) => ({
            key: option || "all",
            label: option || "All tags",
            selected: option === tag,
            select: () => onTagChange(option),
          }))
        : pageSizeOptions.map((option) => ({
            key: String(option),
            label: `${option} per page`,
            selected: option === pageSize,
            select: () => onPageSizeChange(option),
          }));

  return (
    <div role="menu" aria-label={`${title} options`}>
      <div className="flex min-h-11 items-center gap-2 px-1">
        <button
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onBack}
          aria-label="Back to list options"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-xs font-semibold text-foreground">{title}</span>
      </div>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="menuitemradio"
          aria-checked={option.selected}
          className={`flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-muted ${option.selected ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
          onClick={option.select}
        >
          <Check className={`h-4 w-4 shrink-0 ${option.selected ? "opacity-100" : "opacity-0"}`} />
          {option.label}
        </button>
      ))}
    </div>
  );
}

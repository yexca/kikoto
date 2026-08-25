import { Check, Columns3, ListMusic, RefreshCw, Rows3, Search, X } from "lucide-react";
import { useEffect, type ReactNode, type RefObject } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";
import type { CircleDetail } from "@/lib/api";
import type { WorkCollectionColumnSetting } from "@/components/work-collection/WorkCollectionLayout";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";

export type CircleAvailabilityFilter = "all" | "available" | "unavailable" | "local" | "remote";
export type CircleRefreshScope = "all" | "catalog" | "work" | "source" | "metadata";
export type CircleRefreshMode = "incremental" | "full";

export function CircleAdvancedRefreshSheet({
  open,
  mobile,
  anchorRef,
  circle,
  catalogOnlyCount,
  availableCount,
  refreshingScope,
  canRefresh,
  onClose,
  onRun,
}: {
  open: boolean;
  mobile: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  circle: CircleDetail;
  catalogOnlyCount: number;
  availableCount: number;
  refreshingScope: CircleRefreshScope | null;
  canRefresh: boolean;
  onClose: () => void;
  onRun: (scope: CircleRefreshScope, mode: CircleRefreshMode) => void;
}) {
  const headerContent = (
    <div className="min-w-0">
      <h2 id="circle-advanced-refresh-title" className="text-base font-semibold">
        Advanced refresh
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Run a targeted catalog, metadata, or source workflow.</p>
    </div>
  );
  const actionContent = (
    <>
      <RefreshActionRow
        title="Catalog"
        description={`${circle.catalogWorks} works · ${circle.lastSyncedAt ? `last ${circle.lastSyncedAt}` : "never synced"}`}
        disabled={!canRefresh || refreshingScope !== null}
        active={refreshingScope === "catalog" || refreshingScope === "all"}
        onRun={(mode) => onRun("catalog", mode)}
      />
      <RefreshActionRow
        title="Work metadata"
        description={`${catalogOnlyCount} catalog only · ${availableCount} available`}
        disabled={!canRefresh || refreshingScope !== null}
        active={refreshingScope === "work" || refreshingScope === "all"}
        onRun={(mode) => onRun("work", mode)}
      />
      <RefreshActionRow
        title="Sources"
        description={`${circle.localWorks} local · ${circle.remoteWorks} remote · ${circle.missingWorks} missing`}
        disabled={!canRefresh || refreshingScope !== null}
        active={refreshingScope === "source" || refreshingScope === "all"}
        onRun={(mode) => onRun("source", mode)}
      />
    </>
  );
  const content = (
    <div>
      <div className="flex items-start justify-between gap-3">
        {headerContent}
        {!mobile && (
          <Button variant="ghost" size="icon" aria-label="Close advanced refresh actions" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="mt-4 space-y-3">{actionContent}</div>
    </div>
  );

  if (mobile) {
    return (
      <MobileSheet
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
        ariaLabelledby="circle-advanced-refresh-title"
        className="flex flex-col overflow-hidden p-0"
      >
        <MobileSheetHeader>{headerContent}</MobileSheetHeader>
        <MobileSheetBody>
          <div className="space-y-3">{actionContent}</div>
        </MobileSheetBody>
      </MobileSheet>
    );
  }

  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      className="w-[min(30rem,calc(100vw-1.5rem))] p-4"
      bottomCollisionPadding={96}
      zIndex={70}
    >
      <div
        role="dialog"
        id="circle-advanced-refresh"
        aria-labelledby="circle-advanced-refresh-title"
        data-android-back-close
      >
        {content}
      </div>
    </AnchoredPopover>
  );
}

export function CircleCatalogOptionsSheet({
  open,
  onClose,
  isSeriesView,
  selectionMode,
  availabilityFilter,
  onAvailabilityFilterChange,
  query,
  onQueryChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  mobileColumns,
  onMobileColumnsChange,
  onSelectWorks,
}: {
  open: boolean;
  onClose: () => void;
  isSeriesView: boolean;
  selectionMode: boolean;
  availabilityFilter: CircleAvailabilityFilter;
  onAvailabilityFilterChange: (value: CircleAvailabilityFilter) => void;
  query: string;
  onQueryChange: (value: string) => void;
  pageSize: number;
  pageSizeOptions: readonly number[];
  onPageSizeChange: (value: number) => void;
  mobileColumns: WorkCollectionColumnSetting;
  onMobileColumnsChange: (value: WorkCollectionColumnSetting) => void;
  onSelectWorks: () => void;
}) {
  useSheetEscape(open, onClose);

  if (!open) return null;
  const availabilityOptions: { value: CircleAvailabilityFilter; label: string }[] = [
    { value: "all", label: "All works" },
    { value: "available", label: "Available" },
    { value: "unavailable", label: "Unavailable" },
    { value: "local", label: "Local" },
    { value: "remote", label: "Remote" },
  ];
  const columnOptions: { value: WorkCollectionColumnSetting; label: string; ariaLabel: string }[] = [
    { value: "auto", label: "Auto", ariaLabel: "Automatic columns" },
    { value: 1, label: "1", ariaLabel: "1 column" },
    { value: 2, label: "2", ariaLabel: "2 columns" },
  ];

  return (
    <div
      className="visual-viewport-layer z-50 flex items-end bg-background/55 p-2 backdrop-blur-sm lg:hidden sm:p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="circle-catalog-options-title"
        data-android-back-close
        className="app-scroll min-h-0 max-h-full w-full overflow-y-auto rounded-t-lg border bg-card p-4 shadow-xl"
        style={{ paddingBottom: "max(1rem, calc(1rem + var(--safe-area-bottom)))" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="circle-catalog-options-title" className="text-base font-semibold">
              Catalog options
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Filter and choose how works are arranged.</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close catalog options" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm font-medium">Search</legend>
          <div className="flex min-h-11 items-center gap-2 rounded-md border bg-background px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              value={query}
              onKeyDown={dismissKeyboardOnEnter}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search circle catalog works"
              aria-label="Search circle catalog works"
            />
            {query.trim() && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Clear circle catalog search"
                title="Clear circle catalog search"
                onClick={() => onQueryChange("")}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </fieldset>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm font-medium">Availability</legend>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Catalog availability">
            {availabilityOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`flex min-h-11 items-center justify-between rounded-md border px-3 text-left text-sm transition-colors hover:bg-muted ${
                  availabilityFilter === option.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground"
                }`}
                aria-pressed={availabilityFilter === option.value}
                onClick={() => onAvailabilityFilterChange(option.value)}
              >
                {option.label}
                {availabilityFilter === option.value && <Check className="h-4 w-4" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm font-medium">Columns</legend>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Mobile catalog columns">
            {columnOptions.map((option) => (
              <CatalogOptionButton
                key={option.value}
                active={mobileColumns === option.value}
                label={option.label}
                ariaLabel={option.ariaLabel}
                icon={<Columns3 className="h-4 w-4" />}
                onClick={() => onMobileColumnsChange(option.value)}
              />
            ))}
          </div>
        </fieldset>

        {!isSeriesView && (
          <fieldset className="mt-4 space-y-2">
            <legend className="flex items-center gap-2 text-sm font-medium">
              <ListMusic className="h-4 w-4" aria-hidden="true" />
              Per page
            </legend>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Catalog work page size">
              {pageSizeOptions.map((option) => (
                <CatalogOptionButton
                  key={option}
                  active={pageSize === option}
                  label={`${option} per page`}
                  icon={<Rows3 className="h-4 w-4" />}
                  onClick={() => onPageSizeChange(option)}
                />
              ))}
            </div>
          </fieldset>
        )}

        {!isSeriesView && (
          <Button className="mt-4 w-full" variant={selectionMode ? "default" : "outline"} onClick={onSelectWorks}>
            <Check className="h-4 w-4" />
            {selectionMode ? "Exit selection mode" : "Select works"}
          </Button>
        )}
      </div>
    </div>
  );
}

function CatalogOptionButton({
  active,
  label,
  ariaLabel,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  ariaLabel?: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 text-sm transition-colors hover:bg-muted ${
        active ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"
      }`}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {active && <Check className="h-4 w-4 shrink-0" />}
    </button>
  );
}

function RefreshActionRow({
  title,
  description,
  disabled,
  active,
  onRun,
}: {
  title: string;
  description: string;
  disabled?: boolean;
  active?: boolean;
  onRun: (mode: CircleRefreshMode) => void;
}) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{description}</div>
        </div>
        {active && <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button className="h-8" variant="outline" size="sm" disabled={disabled} onClick={() => onRun("incremental")}>
          Incremental
        </Button>
        <Button className="h-8" variant="outline" size="sm" disabled={disabled} onClick={() => onRun("full")}>
          Full
        </Button>
      </div>
    </div>
  );
}

function useSheetEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeWithEscape);
    return () => document.removeEventListener("keydown", closeWithEscape);
  }, [onClose, open]);
}

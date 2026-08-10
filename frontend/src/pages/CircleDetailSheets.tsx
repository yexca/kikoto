import { Check, Columns3, RefreshCw, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { CircleDetail } from "@/lib/api";
import type { WorkCollectionColumnSetting } from "@/components/work-collection/WorkCollectionLayout";

export type CircleAvailabilityFilter = "all" | "available" | "unavailable" | "local" | "remote";
export type CircleRefreshScope = "all" | "catalog" | "work" | "source";
export type CircleRefreshMode = "incremental" | "full";

export function CircleAdvancedRefreshSheet({
  open,
  circle,
  catalogOnlyCount,
  playableCount,
  refreshingScope,
  isTranslationCircle,
  onClose,
  onRun,
}: {
  open: boolean;
  circle: CircleDetail;
  catalogOnlyCount: number;
  playableCount: number;
  refreshingScope: CircleRefreshScope | null;
  isTranslationCircle: boolean;
  onClose: () => void;
  onRun: (scope: CircleRefreshScope, mode: CircleRefreshMode) => void;
}) {
  useSheetEscape(open, onClose);

  if (!open) return null;
  return (
    <div
      className="visual-viewport-layer z-50 flex items-end justify-center bg-background/55 p-2 backdrop-blur-sm sm:p-4 lg:items-center"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="circle-advanced-refresh-title"
        data-android-back-close
        className="app-scroll min-h-0 max-h-full w-full max-w-xl overflow-y-auto rounded-t-lg border bg-card p-4 shadow-xl lg:rounded-lg"
        style={{ paddingBottom: "max(1rem, calc(1rem + var(--safe-area-bottom)))" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="circle-advanced-refresh-title" className="text-base font-semibold">
              Advanced refresh
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Run a targeted catalog, metadata, or source workflow.</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close advanced refresh actions" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-4 space-y-3">
          <RefreshActionRow
            title="Catalog"
            description={`${circle.catalogWorks} works · ${circle.lastSyncedAt ? `last ${circle.lastSyncedAt}` : "never synced"}`}
            disabled={refreshingScope !== null || isTranslationCircle}
            active={refreshingScope === "catalog" || refreshingScope === "all"}
            onRun={(mode) => onRun("catalog", mode)}
          />
          <RefreshActionRow
            title="Work metadata"
            description={`${catalogOnlyCount} catalog only · ${playableCount} playable`}
            disabled={refreshingScope !== null}
            active={refreshingScope === "work" || refreshingScope === "all"}
            onRun={(mode) => onRun("work", mode)}
          />
          <RefreshActionRow
            title="Sources"
            description={`${circle.localWorks} local · ${circle.remoteWorks} remote · ${circle.missingWorks} missing`}
            disabled={refreshingScope !== null || isTranslationCircle}
            active={refreshingScope === "source" || refreshingScope === "all"}
            onRun={(mode) => onRun("source", mode)}
          />
          {isTranslationCircle && (
            <p className="text-xs text-muted-foreground">
              Catalog and source refresh are disabled for translation umbrella circles.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function CircleCatalogOptionsSheet({
  open,
  onClose,
  isSeriesView,
  selectionMode,
  availabilityFilter,
  onAvailabilityFilterChange,
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

import { BookmarkCheck, Check, FilterX, Layers, ListChecks, ListFilter, Search, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SortControl } from "@/components/collection/SortControl";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { quickMarkMeta } from "@/components/work-card/WorkCardShell";
import type { FavoriteSort, SortDirection } from "@/lib/api";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { cn } from "@/lib/tailwindClassNames";
import type { FavoriteStatusFilterOption } from "./favoriteShelfModel";
import type { FavoriteAvailability, FavoriteStatusFilter } from "./favoritesBrowseState";

export function FavoriteSearchInput({
  value,
  placeholder,
  onChange,
  className,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <label
      className={cn(
        "flex h-9 min-w-0 items-center gap-2 rounded-[var(--control-radius)] border border-input bg-card px-3 text-sm transition-[border-color,box-shadow] focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-ring/30",
        className,
      )}
    >
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        className="min-w-0 flex-1 bg-transparent py-2 outline-none placeholder:text-muted-foreground"
        value={value}
        onKeyDown={dismissKeyboardOnEnter}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {value.trim() && (
        <button
          type="button"
          className="-mr-1 grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onChange("")}
          aria-label={t("library.clearSearch")}
          title={t("library.clearSearch")}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </label>
  );
}

const favoriteResourceOptions: FavoriteAvailability[] = ["all", "available", "local", "remote", "missing"];

/**
 * The one filter button of a works shelf: listening status, with each status's
 * count on the shelf, and resource availability. While either is set, the
 * button turns primary, carries the status's quick mark icon, and a wide
 * layout names the filters. The popover stays open so both can be set together.
 * Phones show the status as a chip row of their own, so their popover holds
 * only the resource.
 */
export function FavoriteFilterMenu({
  status,
  statusOptions,
  availability,
  compact = false,
  onStatusChange,
  onAvailabilityChange,
  onClear,
}: {
  status: FavoriteStatusFilter;
  statusOptions: FavoriteStatusFilterOption[];
  availability: FavoriteAvailability;
  /** Phones draw only the icon, leave the status to its chips, and keep the popover clear of the bottom navigation. */
  compact?: boolean;
  onStatusChange: (value: FavoriteStatusFilter) => void;
  onAvailabilityChange: (value: FavoriteAvailability) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const statusLabel = (option: FavoriteStatusFilter) =>
    option === "all"
      ? t("favorites.allStatuses")
      : option === "marked"
        ? t("favorites.anyMark")
        : t(`library.status.${option}`);
  const resourceLabel = (option: FavoriteAvailability) => {
    switch (option) {
      case "available":
        return t("content.available");
      case "local":
        return t("detailActions.local");
      case "remote":
        return t("detailActions.remote");
      case "missing":
        return t("favorites.missing");
      default:
        return t("favorites.allResources");
    }
  };
  const shownStatus = compact ? "all" : status;
  const active = shownStatus !== "all" || availability !== "all";
  const meta = shownStatus === "all" || shownStatus === "marked" ? null : quickMarkMeta(shownStatus);
  const Icon = meta?.icon ?? (shownStatus === "marked" ? BookmarkCheck : ListFilter);
  const value = [
    shownStatus !== "all" ? statusLabel(shownStatus) : "",
    availability !== "all" ? resourceLabel(availability) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const label = active ? t("favorites.filtersValue", { value }) : t("favorites.filters");
  const named = active && !compact;

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <Button
        type="button"
        variant="toolbar"
        size={named ? "sm" : "icon-sm"}
        className={cn(
          named && "h-8 max-w-48 gap-1.5",
          active &&
            "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary aria-expanded:bg-primary/15 aria-expanded:text-primary",
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon className={cn("h-4 w-4 shrink-0", meta?.className)} aria-hidden="true" />
        {named && <span className="truncate">{value}</span>}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="end"
        ariaLabel={t("favorites.filters")}
        bottomCollisionPadding={compact ? 168 : undefined}
        className="w-[min(16rem,calc(100vw-1.5rem))] p-1.5 text-sm"
      >
        {!compact && (
          <FilterSection label={t("favorites.statusFilters")} heading={t("favorites.status")}>
            {statusOptions.map((option) => {
              const optionMeta =
                option.value === "all" || option.value === "marked" ? null : quickMarkMeta(option.value);
              const OptionIcon = optionMeta?.icon ?? (option.value === "marked" ? BookmarkCheck : Layers);
              return (
                <FilterOption
                  key={option.value}
                  selected={option.value === status}
                  muted={option.count === 0}
                  icon={<OptionIcon className={cn("h-4 w-4", optionMeta?.className)} />}
                  count={option.count}
                  onSelect={() => onStatusChange(option.value)}
                >
                  {statusLabel(option.value)}
                </FilterOption>
              );
            })}
          </FilterSection>
        )}
        {/* Short names fit as wrapping chips, which keeps the popover within a phone screen. */}
        <FilterSection label={t("favorites.resourceFilters")} heading={t("favorites.resource")} chips>
          {favoriteResourceOptions.map((option) => {
            const selected = option === availability;
            return (
              <li key={option}>
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-[var(--badge-radius)] border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "border-primary/30 bg-primary/10 font-medium text-primary"
                      : "bg-card text-foreground/80 hover:bg-muted hover:text-foreground",
                  )}
                  aria-pressed={selected}
                  onClick={() => onAvailabilityChange(option)}
                >
                  {resourceLabel(option)}
                </button>
              </li>
            );
          })}
        </FilterSection>
        {active && (
          <div className="mt-1 border-t pt-1">
            <button
              type="button"
              className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={compact ? () => onAvailabilityChange("all") : onClear}
            >
              <FilterX className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t("favorites.clearFilters")}
            </button>
          </div>
        )}
      </AnchoredPopover>
    </div>
  );
}

function FilterSection({
  label,
  heading,
  chips = false,
  children,
}: {
  label: string;
  heading: string;
  chips?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="py-1 [&+&]:border-t" aria-label={label}>
      <p className="px-2.5 pb-1 pt-0.5 text-xs font-medium text-muted-foreground" aria-hidden="true">
        {heading}
      </p>
      <ul className={chips ? "flex flex-wrap gap-1.5 px-2.5 pb-1.5 pt-0.5" : undefined}>{children}</ul>
    </section>
  );
}

function FilterOption({
  selected,
  muted = false,
  icon,
  count,
  onSelect,
  children,
}: {
  selected: boolean;
  /** An option that holds no works on this shelf. */
  muted?: boolean;
  icon: ReactNode;
  count?: number;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "bg-primary/10 font-medium text-primary" : "text-foreground",
          muted && !selected && "opacity-60",
        )}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {count !== undefined && (
          <span className={cn("shrink-0 text-xs tabular-nums", selected ? "text-primary/80" : "text-muted-foreground")}>
            {count}
          </span>
        )}
        {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
      </button>
    </li>
  );
}

const favoriteSortOptions: FavoriteSort[] = [
  "activity",
  "added",
  "release",
  "code",
  "title",
  "rating",
  "user_rating",
  "sales",
  "random",
];

/** The Favorites order: the shared sort control with the Favorites order names; Random reshuffles. */
export function FavoriteSortControls({
  value,
  direction,
  disabled,
  onChange,
  onDirectionChange,
  onReshuffle,
}: {
  value: FavoriteSort;
  direction: SortDirection;
  disabled: boolean;
  onChange: (value: FavoriteSort) => void;
  onDirectionChange: (value: SortDirection) => void;
  onReshuffle: () => void;
}) {
  const { t } = useTranslation();
  const sortLabel = (option: FavoriteSort) =>
    option === "activity"
      ? t("favorites.sortActivity")
      : option === "added"
        ? t("favorites.sortMarkedOrAdded")
        : t(`library.sortOptions.${option}`);
  return (
    <SortControl
      options={favoriteSortOptions.map((option) => ({ value: option, label: sortLabel(option) }))}
      value={value}
      direction={direction}
      disabled={disabled}
      onChange={onChange}
      onDirectionChange={onDirectionChange}
      reshuffle={value === "random" ? { label: t("library.reshuffle"), onReshuffle } : undefined}
      align="end"
    />
  );
}

export function FavoriteSelectionToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <IconButton
      title={active ? t("favorites.exitSelection") : t("favorites.selectWorks")}
      aria-pressed={active}
      onClick={onToggle}
    >
      <ListChecks className={`h-4 w-4 ${active ? "text-primary" : ""}`} />
    </IconButton>
  );
}

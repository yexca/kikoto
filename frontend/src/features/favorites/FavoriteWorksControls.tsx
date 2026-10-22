import { ArrowDownAZ, ArrowDownZA, ArrowUpDown, Check, Cloud, ListChecks, RefreshCw, Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { FavoriteSort, SortDirection } from "@/lib/api";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { cn } from "@/lib/tailwindClassNames";
import type { FavoriteAvailability } from "./favoritesBrowseState";

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

/** Availability filter; compact draws only the icon. */
export function FavoriteResourceFilter({
  value,
  compact = false,
  onChange,
}: {
  value: FavoriteAvailability;
  compact?: boolean;
  onChange: (value: FavoriteAvailability) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
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
  const label = resourceLabel(value);

  return (
    <div className="relative" ref={anchorRef}>
      <Button
        variant="toolbar"
        size={compact ? "icon-sm" : "sm"}
        className={cn(
          compact ? "" : "h-8 max-w-44",
          value !== "all" && "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        )}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        aria-label={`${t("favorites.resource")}: ${label}`}
        title={`${t("favorites.resource")}: ${label}`}
      >
        <Cloud className={compact ? "h-4 w-4" : "h-3.5 w-3.5 shrink-0"} />
        {!compact && <span className="truncate">{label}</span>}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="end"
        className="w-[min(10rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={t("favorites.resourceFilters")}>
          {favoriteResourceOptions.map((option) => {
            const selected = option === value;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-muted ${selected ? "bg-primary/10 font-medium text-primary" : "text-foreground"}`}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{resourceLabel(option)}</span>
                {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </div>
  );
}

const favoriteSortOptions: FavoriteSort[] = [
  "activity",
  "added",
  "release",
  "code",
  "title",
  "rating",
  "sales",
  "random",
];

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
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const sortLabel = (option: FavoriteSort) =>
    option === "activity"
      ? t("favorites.sortActivity")
      : option === "added"
        ? t("favorites.sortMarkedOrAdded")
        : t(`library.sortOptions.${option}`);
  const label = sortLabel(value);
  const directionTitle =
    value === "random"
      ? t("library.reshuffle")
      : direction === "asc"
        ? t("library.ascending")
        : t("library.descending");
  return (
    <div className="relative" ref={anchorRef}>
      <div className="inline-flex h-8 shrink-0 items-center rounded-[var(--control-radius)] border bg-background">
        <button
          type="button"
          className="inline-flex h-full min-w-0 max-w-44 items-center gap-1.5 rounded-l-[var(--control-radius)] px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          aria-label={t("library.sortLabel", { label })}
          title={t("library.sortLabel", { label })}
        >
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate text-foreground">{label}</span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-full w-8 rounded-l-none border-l text-muted-foreground"
          disabled={disabled}
          onClick={() => (value === "random" ? onReshuffle() : onDirectionChange(direction === "asc" ? "desc" : "asc"))}
          aria-label={directionTitle}
          title={directionTitle}
        >
          {value === "random" ? (
            <RefreshCw className="h-4 w-4" />
          ) : direction === "asc" ? (
            <ArrowDownAZ className="h-4 w-4" />
          ) : (
            <ArrowDownZA className="h-4 w-4" />
          )}
        </Button>
      </div>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="end"
        className="w-[min(12rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={t("favorites.sortOptions")}>
          {favoriteSortOptions.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={value === option}
              className={`flex min-h-10 w-full items-center rounded-md px-3 py-2 text-left hover:bg-muted ${value === option ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {sortLabel(option)}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
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

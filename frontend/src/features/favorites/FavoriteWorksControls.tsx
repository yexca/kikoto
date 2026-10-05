import {
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUpDown,
  Check,
  Cloud,
  LayoutGrid,
  List as ListIcon,
  ListChecks,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { FavoriteSort, LibrarySource, SortDirection } from "@/lib/api";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { cn } from "@/lib/tailwindClassNames";
import type { FavoriteAvailability } from "./favoritesBrowseState";
import type { FavoriteViewMode } from "./favoriteViewMode";

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

export type FavoriteResourceSelection = {
  availability: FavoriteAvailability;
  sourceIDs: number[];
};

/** Availability and file source filter; compact draws only the icon. */
export function FavoriteResourceFilter({
  availability,
  sources,
  selectedSourceIDs,
  loading,
  compact = false,
  onChange,
}: {
  availability: FavoriteAvailability;
  sources: LibrarySource[];
  selectedSourceIDs: number[];
  loading: boolean;
  compact?: boolean;
  onChange: (selection: FavoriteResourceSelection) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const label = favoriteResourceLabel(sources, { availability, sourceIDs: selectedSourceIDs }, t);
  const filtered = availability !== "all" || selectedSourceIDs.length > 0;
  const select = (next: FavoriteResourceSelection) => {
    onChange(next);
    setOpen(false);
  };
  const isOnly = (value: FavoriteAvailability) => availability === value && selectedSourceIDs.length === 0;

  return (
    <div className="relative" ref={anchorRef}>
      <Button
        variant="toolbar"
        size={compact ? "icon-sm" : "sm"}
        className={cn(
          compact ? "" : "h-8 max-w-44",
          filtered && "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        )}
        disabled={loading}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        aria-label={`${t("favorites.resource")}: ${label}`}
        title={`${t("favorites.resource")}: ${label}`}
      >
        <Cloud className={compact ? "h-4 w-4" : "h-3.5 w-3.5 shrink-0"} />
        {!compact && <span className="truncate">{label}</span>}
      </Button>
      <AnchoredPopover
        open={open && !loading}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="end"
        className="w-[min(18rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={t("favorites.resourceFilters")}>
          <div className="px-3 py-2 text-xs font-semibold text-foreground">{t("favorites.resource")}</div>
          <FavoriteResourceOption
            label={t("favorites.anyAvailable")}
            selected={isOnly("all")}
            onClick={() => select({ availability: "all", sourceIDs: [] })}
          />
          <FavoriteResourceOption
            label={t("detailActions.local")}
            selected={isOnly("local")}
            onClick={() => select({ availability: "local", sourceIDs: [] })}
          />
          <FavoriteResourceOption
            label={t("favorites.cached")}
            selected={isOnly("cache")}
            onClick={() => select({ availability: "cache", sourceIDs: [] })}
          />
          <FavoriteResourceOption
            label={t("favorites.anyRemote")}
            selected={isOnly("remote")}
            onClick={() => select({ availability: "remote", sourceIDs: [] })}
          />
          {sources.map((source) => (
            <FavoriteResourceOption
              key={source.id}
              label={source.displayName || source.code}
              selected={
                availability === "remote" && selectedSourceIDs.length === 1 && selectedSourceIDs[0] === source.id
              }
              onClick={() => select({ availability: "remote", sourceIDs: [source.id] })}
              icon={<Cloud className="h-3.5 w-3.5 shrink-0" />}
              suffix={!source.enabled ? t("favorites.disabled") : undefined}
            />
          ))}
          <FavoriteResourceOption
            label={t("favorites.missing")}
            selected={isOnly("missing")}
            onClick={() => select({ availability: "missing", sourceIDs: [] })}
          />
        </div>
      </AnchoredPopover>
    </div>
  );
}

function FavoriteResourceOption({
  label,
  selected,
  onClick,
  icon,
  suffix,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  icon?: ReactNode;
  suffix?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted ${selected ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
      onClick={onClick}
    >
      <Check className={`h-4 w-4 shrink-0 ${selected ? "opacity-100" : "opacity-0"}`} />
      {icon}
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      {suffix && <span className="text-2xs text-muted-foreground">{suffix}</span>}
    </button>
  );
}

function favoriteResourceLabel(
  sources: LibrarySource[],
  selection: FavoriteResourceSelection,
  translate: (key: string) => string,
) {
  if (selection.sourceIDs.length === 1) {
    const source = sources.find((candidate) => candidate.id === selection.sourceIDs[0]);
    return source?.displayName || source?.code || translate("detailActions.source");
  }
  switch (selection.availability) {
    case "local":
      return translate("detailActions.local");
    case "cache":
      return translate("favorites.cached");
    case "remote":
      return translate("favorites.anyRemote");
    case "missing":
      return translate("favorites.missing");
    default:
      return translate("favorites.anyAvailable");
  }
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
  compact = false,
  onChange,
  onDirectionChange,
  onReshuffle,
}: {
  value: FavoriteSort;
  direction: SortDirection;
  disabled: boolean;
  compact?: boolean;
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
          className={cn(
            "inline-flex h-full items-center gap-1.5 rounded-l-[var(--control-radius)] px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            compact ? "w-8 justify-center px-0" : "min-w-0 max-w-44",
          )}
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          aria-label={t("library.sortLabel", { label })}
          title={t("library.sortLabel", { label })}
        >
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />
          {!compact && <span className="truncate text-foreground">{label}</span>}
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

/** Grid or list; the two buttons form one segmented control. */
export function FavoriteViewToggle({
  value,
  onChange,
}: {
  value: FavoriteViewMode;
  onChange: (value: FavoriteViewMode) => void;
}) {
  const { t } = useTranslation();
  const options = [
    { value: "grid" as const, label: t("favorites.gridView"), icon: LayoutGrid },
    { value: "list" as const, label: t("favorites.listView"), icon: ListIcon },
  ];
  return (
    <div
      className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-[var(--control-radius)] border bg-muted p-0.5"
      role="group"
      aria-label={t("favorites.viewMode")}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={cn(
              "touch-target relative grid h-full w-7 place-items-center rounded-[calc(var(--control-radius)-2px)] transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-card text-primary shadow-sm ring-1 ring-foreground/5"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.value)}
          >
            <option.icon className="h-4 w-4" />
          </button>
        );
      })}
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

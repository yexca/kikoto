import { Check, Loader2, Minus, Plus, Zap } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { toastFromError } from "@/components/ui/toast";
import type { FavoriteList } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { FavoriteListIconGlyph } from "./FavoriteListIconGlyph";
import {
  favoriteListCreateName,
  filterFavoriteListsByName,
  type FavoriteListPickerState,
} from "./favoriteListPickerModel";

export type FavoriteListPickerOption = {
  list: FavoriteList;
  state: FavoriteListPickerState;
  /** A second line under the name, such as why a smart list holds the work. */
  note?: string;
  /** Short trailing text, such as a pending change or how many works the list holds. */
  hint?: string;
  /** The hint spelled out for assistive technology and the tooltip. */
  hintLabel?: string;
  hintTone?: "add" | "remove" | "neutral";
  busy?: boolean;
};

type PickerRow = { kind: "list"; option: FavoriteListPickerOption } | { kind: "create"; name: string };

/**
 * Searchable list of the user's lists with an in-place create row. The caller
 * owns membership: each choice reports a list id, and a created list is
 * reported once it exists.
 */
export function FavoriteListPicker({
  label,
  options,
  loadError,
  canCreate,
  autoFocusSearch,
  disabled = false,
  onToggle,
  onCreate,
  footer,
}: {
  label: string;
  /** Null while the lists load. */
  options: FavoriteListPickerOption[] | null;
  loadError?: string;
  canCreate: boolean;
  /** Focus the search when the picker opens; phones leave it alone so the keyboard stays closed. */
  autoFocusSearch: boolean;
  disabled?: boolean;
  onToggle: (listId: number) => void;
  onCreate: (name: string) => Promise<void>;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [creating, setCreating] = useState("");
  const [createError, setCreateError] = useState("");

  // The popover stays invisible until it is positioned, which defeats autoFocus.
  useEffect(() => {
    if (!autoFocusSearch) return;
    const timer = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }));
    return () => window.clearTimeout(timer);
  }, [autoFocusSearch]);

  const rows = useMemo<PickerRow[]>(() => {
    const all = options ?? [];
    const matches = filterFavoriteListsByName(
      all.map((option) => ({ name: option.list.name, option })),
      query,
    ).map(({ option }): PickerRow => ({ kind: "list", option }));
    const createName =
      canCreate && options
        ? favoriteListCreateName(
            all.map((option) => option.list),
            query,
          )
        : null;
    return createName ? [...matches, { kind: "create", name: createName }] : matches;
  }, [canCreate, options, query]);
  const active = activeIndex >= 0 && activeIndex < rows.length ? activeIndex : -1;

  const updateQuery = (value: string) => {
    setQuery(value);
    setCreateError("");
    setActiveIndex(value.trim() ? 0 : -1);
  };

  const create = async (name: string) => {
    if (creating || disabled) return;
    setCreating(name);
    setCreateError("");
    try {
      await onCreate(name);
      updateQuery("");
    } catch (error) {
      setCreateError(toastFromError(error, t("workCard.listCreateFailed")).message);
    } finally {
      setCreating("");
    }
  };

  const choose = (row: PickerRow) => {
    if (disabled) return;
    if (row.kind === "create") {
      void create(row.name);
      return;
    }
    onToggle(row.option.list.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter confirms an IME candidate before it ever means "choose this list".
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(active < 0 ? (step > 0 ? 0 : rows.length - 1) : (active + step + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (active >= 0) choose(rows[active]);
    }
  };

  const optionId = (index: number) => `${listboxId}-option-${index}`;
  const searchLabel = canCreate ? t("workCard.listSearchOrCreate") : t("workCard.listSearch");

  return (
    <div className="flex min-h-0 flex-col" onClick={(event) => event.stopPropagation()}>
      <div className="border-b p-2">
        <Input
          ref={inputRef}
          fieldSize="sm"
          className="w-full"
          value={query}
          placeholder={searchLabel}
          aria-label={searchLabel}
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {createError && (
          <p role="alert" className="mt-1.5 px-1 text-xs text-destructive">
            {createError}
          </p>
        )}
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-multiselectable="true"
        aria-label={label}
        aria-busy={options === null}
        className="app-scrollbar max-h-72 min-h-0 overflow-y-auto p-1"
      >
        {rows.map((row, index) => (
          <div
            key={row.kind === "create" ? "create" : row.option.list.id}
            id={optionId(index)}
            role="option"
            aria-selected={row.kind === "list" && row.option.state === "checked"}
            aria-checked={row.kind === "list" && row.option.state === "mixed" ? "mixed" : undefined}
            aria-disabled={disabled || (row.kind === "create" && Boolean(creating)) || undefined}
            className={cn(
              "flex min-h-10 cursor-pointer select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
              index === active && "bg-muted",
              disabled && "cursor-default opacity-60",
            )}
            // Keep focus in the search so typing can continue after a click.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => {
              if (index !== active) setActiveIndex(index);
            }}
            onClick={() => choose(row)}
          >
            {row.kind === "create" ? (
              <>
                {creating ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                ) : (
                  <Plus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate">{t("workCard.createList", { name: row.name })}</span>
              </>
            ) : (
              <ListRow option={row.option} />
            )}
          </div>
        ))}
        {options === null && !loadError && (
          <div className="grid place-items-center py-4 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-label={t("workCard.loadingLists")} />
          </div>
        )}
        {options !== null && rows.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            {query.trim() ? t("workCard.noMatchingLists") : t("workCard.noLists")}
          </p>
        )}
      </div>
      {loadError && <p className="border-t px-3 py-2 text-xs text-muted-foreground">{loadError}</p>}
      {footer}
    </div>
  );
}

function ListRow({ option }: { option: FavoriteListPickerOption }) {
  const { list, state, note, hint, hintLabel, hintTone = "neutral", busy } = option;
  return (
    <>
      <FavoriteListIconGlyph list={list} />
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={list.name}>
          {list.name}
        </span>
        {note && (
          <span className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
            <Zap className="mt-px h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0">{note}</span>
          </span>
        )}
      </span>
      {hint && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            hintTone === "add" ? "text-primary" : hintTone === "remove" ? "text-destructive" : "text-muted-foreground",
          )}
          title={hintLabel}
        >
          <span aria-hidden={hintLabel ? true : undefined}>{hint}</span>
          {hintLabel && <span className="sr-only">{hintLabel}</span>}
        </span>
      )}
      <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden="true">
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : state === "checked" ? (
          <Check className="h-4 w-4 text-primary" strokeWidth={2.5} />
        ) : state === "mixed" ? (
          <Minus className="h-4 w-4 text-muted-foreground" strokeWidth={2.5} />
        ) : null}
      </span>
    </>
  );
}

import { Check, Loader2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";
import {
  buildUserTagEditorOptions,
  maxUserTagNameLength,
  toggleUserTag,
  type UserTagEditorOption,
} from "@/components/userTagEditorModel";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { api, type UserTagScope, type UserTagSuggestion } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

export type UserTag = {
  id: number;
  name: string;
  color?: string;
};

type UserTagRowProps = {
  tags: UserTag[];
  scope: UserTagScope;
  /** Receives the complete tag set. Callers report their own failures. */
  onSave: (tags: string[]) => Promise<void> | void;
  className?: string;
  compact?: boolean;
};

// Last loaded vocabulary per scope, so a reopened editor lists suggestions
// immediately while it refreshes.
const suggestionCache = new Map<UserTagScope, UserTagSuggestion[]>();

export function UserTagRow({ tags, scope, onSave, className = "", compact = false }: UserTagRowProps) {
  const { t } = useTranslation();
  const mobile = useMobileNavigationLayout();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  // Each toggle applies at once. Saves run one at a time and coalesce to the
  // latest set, so fast toggles cannot land out of order. The optimistic set
  // clears once the queue drains and the caller's tags take over again, which
  // also reverts a failed save.
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const optimisticRef = useRef<string[] | null>(null);
  const pendingRef = useRef<string[] | null>(null);
  const savingRef = useRef(false);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const savedNames = useMemo(() => tags.map((tag) => tag.name), [tags]);
  const selected = optimistic ?? savedNames;

  const flush = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      while (pendingRef.current) {
        const next = pendingRef.current;
        pendingRef.current = null;
        try {
          await onSaveRef.current(next);
        } catch {
          // The caller already reported the failure; the next queued set still applies.
        }
      }
    } finally {
      savingRef.current = false;
      optimisticRef.current = null;
      setOptimistic(null);
    }
  }, []);

  const toggle = (name: string) => {
    const next = toggleUserTag(optimisticRef.current ?? savedNames, name);
    optimisticRef.current = next;
    setOptimistic(next);
    pendingRef.current = next;
    void flush();
  };

  const openEditor = () => {
    setSession((current) => current + 1);
    setOpen(true);
  };

  const title = t("tags.edit");
  const editor = (
    <UserTagEditor key={session} scope={scope} selected={selected} saving={optimistic !== null} onToggle={toggle} />
  );

  const visibleTags = compact ? selected.slice(0, 4) : selected;
  const hiddenCount = selected.length - visibleTags.length;

  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}>
      {selected.length > 0 && (
        <ul className="contents" aria-label={t("tags.title")}>
          {visibleTags.map((name) => (
            <li key={name.toLowerCase()} className="contents">
              <Badge variant="outline" className="max-w-32 truncate" title={name}>
                {name}
              </Badge>
            </li>
          ))}
          {hiddenCount > 0 && (
            <li className="contents">
              <Badge variant="secondary">+{hiddenCount}</Badge>
            </li>
          )}
        </ul>
      )}
      <span ref={anchorRef} className="inline-flex">
        <Button
          type="button"
          variant={selected.length > 0 ? "ghost" : "outline"}
          size="icon"
          className={`h-7 w-7 ${selected.length > 0 ? "text-muted-foreground" : "border-dashed text-muted-foreground"}`}
          aria-label={selected.length > 0 ? title : t("tags.add")}
          title={selected.length > 0 ? title : t("tags.add")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            if (open) setOpen(false);
            else openEditor();
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </span>
      {mobile ? (
        <MobileSheet open={open} onOpenChange={setOpen} ariaLabel={title}>
          <MobileSheetHeader>
            <h2 className="text-base font-semibold">{title}</h2>
            <Button variant="ghost" size="icon" aria-label={t("common.close")} onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </MobileSheetHeader>
          <MobileSheetBody className="p-0">{editor}</MobileSheetBody>
        </MobileSheet>
      ) : (
        <AnchoredPopover
          open={open}
          anchorRef={anchorRef}
          ariaLabel={title}
          align="start"
          onOpenChange={setOpen}
          className="w-72 overflow-hidden p-0"
        >
          {editor}
        </AnchoredPopover>
      )}
    </div>
  );
}

function UserTagEditor({
  scope,
  selected,
  saving,
  onToggle,
}: {
  scope: UserTagScope;
  selected: string[];
  saving: boolean;
  onToggle: (name: string) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  // Tags the entity had on open, then tags created here, keep their rows in place.
  const [pinned, setPinned] = useState(() => selected);
  const [suggestions, setSuggestions] = useState<UserTagSuggestion[] | null>(() => suggestionCache.get(scope) ?? null);
  const [suggestionsFailed, setSuggestionsFailed] = useState(false);

  // The popover stays invisible until it is positioned, which defeats autoFocus.
  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }));
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listUserTags(scope, controller.signal)
      .then((result) => {
        suggestionCache.set(scope, result.tags);
        setSuggestions(result.tags);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSuggestionsFailed(true);
      });
    return () => controller.abort();
  }, [scope]);

  const options = useMemo(
    () => buildUserTagEditorOptions({ query, selected, pinned, suggestions: suggestions ?? [] }),
    [pinned, query, selected, suggestions],
  );
  const active = activeIndex >= 0 && activeIndex < options.length ? activeIndex : -1;

  const updateQuery = (value: string) => {
    setQuery(value);
    setActiveIndex(value.trim() ? 0 : -1);
  };

  const choose = (option: UserTagEditorOption) => {
    if (option.kind === "create") setPinned((current) => [...current, option.name]);
    onToggle(option.name);
    if (query) updateQuery("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter confirms an IME candidate before it ever means "choose this tag".
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(
        active < 0 ? (step > 0 ? 0 : options.length - 1) : (active + step + options.length) % options.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (active >= 0) choose(options[active]);
    }
  };

  const optionId = (index: number) => `${listId}-option-${index}`;
  const loading = suggestions === null && !suggestionsFailed;

  return (
    <div className="flex min-h-0 flex-col" onClick={(event) => event.stopPropagation()}>
      <div className="relative border-b p-2">
        <Input
          ref={inputRef}
          fieldSize="sm"
          className="w-full pr-8"
          value={query}
          maxLength={maxUserTagNameLength}
          placeholder={t("tags.searchPlaceholder")}
          aria-label={t("tags.searchPlaceholder")}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {saving && (
          <Loader2
            className="absolute right-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-multiselectable="true"
        aria-label={t("tags.title")}
        className="app-scrollbar max-h-72 overflow-y-auto p-1"
      >
        {options.map((option, index) => {
          const isSelected = option.kind === "tag" && option.selected;
          return (
            <div
              key={option.kind === "create" ? "create" : option.name.toLowerCase()}
              id={optionId(index)}
              role="option"
              aria-selected={isSelected}
              className={cn(
                "flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-sm",
                index === active && "bg-muted",
              )}
              // Keep focus in the input so typing can continue after a click.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (index !== active) setActiveIndex(index);
              }}
              onClick={() => choose(option)}
            >
              {option.kind === "create" ? (
                <>
                  <Plus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("tags.create", { name: option.name })}</span>
                </>
              ) : (
                <>
                  <span
                    className={cn(
                      "grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border",
                      isSelected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                    )}
                    aria-hidden="true"
                  >
                    {isSelected && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={option.name}>
                    {option.name}
                  </span>
                  {option.usageCount ? (
                    <span className="shrink-0 text-2xs tabular-nums text-muted-foreground" aria-hidden="true">
                      {option.usageCount}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          );
        })}
        {options.length === 0 &&
          (loading ? (
            <div className="grid place-items-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            </div>
          ) : (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t("tags.empty")}</p>
          ))}
      </div>
      {suggestionsFailed && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t("tags.suggestionsFailed")}</p>
      )}
    </div>
  );
}

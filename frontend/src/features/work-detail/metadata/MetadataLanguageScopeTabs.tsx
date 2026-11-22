import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Languages, Triangle } from "lucide-react";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { cn } from "@/lib/tailwindClassNames";
import {
  metadataLanguageScopeLabel,
  type MetadataLanguageScope,
  type MetadataLanguageScopes,
} from "./metadataLanguageScope";

/**
 * The editor's language strip, a segmented control: every language, each
 * supported language, and a More segment whose menu holds this work's editions
 * in other languages. Choosing one selects More and names the language on it.
 */
export function MetadataLanguageScopeTabs({
  scopes,
  selected,
  onSelect,
}: {
  scopes: MetadataLanguageScopes;
  selected: string;
  onSelect: (key: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const label = (scope: MetadataLanguageScope) => metadataLanguageScopeLabel(scope, t, i18n.language);
  const selectedMore = scopes.more.find((scope) => scope.key === selected);

  // A narrow strip scrolls sideways; keep the selected language in view.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[aria-selected='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      (
        menuRef.current?.querySelector<HTMLElement>("[aria-checked='true']") ??
        menuRef.current?.querySelector<HTMLElement>("button")
      )?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const close = () => {
    setOpen(false);
    moreRef.current?.focus();
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="space-y-2 pb-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("metadataEditor.languageScope")}
      </p>
      <div
        ref={listRef}
        role="tablist"
        aria-label={t("metadataEditor.languageScope")}
        // The strip scrolls sideways on a narrow screen without showing a scrollbar under the tabs.
        className={segmentedListClassName("![scrollbar-width:none] [&::-webkit-scrollbar]:hidden")}
      >
        {scopes.primary.map((scope) => {
          const active = scope.key === selected;
          return (
            <button
              key={scope.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={segmentedItemClassName(active, "h-9 sm:h-8")}
              onClick={() => onSelect(scope.key)}
            >
              {label(scope)}
            </button>
          );
        })}
        <span className="my-1.5 w-px shrink-0 bg-border" aria-hidden="true" />
        <button
          ref={moreRef}
          type="button"
          role="tab"
          aria-selected={Boolean(selectedMore)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          className={segmentedItemClassName(Boolean(selectedMore), "h-9 gap-1.5 sm:h-8")}
          onClick={() => setOpen((current) => !current)}
        >
          {selectedMore
            ? t("metadataEditor.moreLanguageSelected", { language: label(selectedMore) })
            : t("metadataEditor.moreLanguages")}
          <Triangle
            className={cn(
              "h-2 w-2 shrink-0 fill-current transition-transform motion-reduce:transition-none",
              !open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      <AnchoredPopover
        open={open}
        anchorRef={moreRef}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setOpen(true);
          else close();
        }}
        floatingLayer
        className="w-max min-w-40 max-w-[min(14rem,calc(100vw-1.5rem))] p-1"
        zIndex={70}
      >
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={t("metadataEditor.otherLanguages")}
          className="text-sm"
          onKeyDown={onMenuKeyDown}
        >
          <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground" aria-hidden="true">
            {t("metadataEditor.otherLanguages")}
          </p>
          {scopes.more.map((scope) => {
            const active = scope.key === selected;
            return (
              <button
                key={scope.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                tabIndex={-1}
                className={cn(
                  "flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left focus:outline-none sm:min-h-9",
                  active ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted focus:bg-muted",
                )}
                onClick={() => {
                  onSelect(scope.key);
                  close();
                }}
              >
                <span className="min-w-0 truncate">{label(scope)}</span>
                {active && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
          {!scopes.more.length && (
            <p className="px-3 pb-2 pt-1 text-muted-foreground">{t("metadataEditor.noOtherLanguages")}</p>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, FileAudio, Loader2, Search, X } from "lucide-react";

import { commandActions, type CommandAction } from "@/app/commandActions";
import { type NavigationItem, type PageID } from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { cx } from "@/lib/classNames";
import { isWorkCode } from "@/lib/workCode";

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasPermission: (permission: string) => boolean;
  canView?: (permission: string) => boolean;
  visibleNavItems: readonly NavigationItem[];
  onBusyChange?: (busy: boolean) => void;
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
};

type PaletteAction = CommandAction & {
  disabled?: boolean;
};

export function CommandPalette({
  open,
  onOpenChange,
  hasPermission,
  canView,
  visibleNavItems,
  onBusyChange,
  onOpenPage,
  onOpenPath,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const mobile = useMobileNavigationLayout();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baseActions = useMemo<PaletteAction[]>(
    () => commandActions({ hasPermission, canView, visibleNavItems, translate: t, onOpenPage, onOpenPath }),
    [canView, hasPermission, t, visibleNavItems, onOpenPage, onOpenPath],
  );
  const cleanQuery = query.trim();
  const codeMatch = isWorkCode(cleanQuery);

  const actions = useMemo<PaletteAction[]>(() => {
    const queryLower = cleanQuery.toLowerCase();
    const filtered = queryLower
      ? baseActions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(queryLower))
      : baseActions;
    if (!codeMatch) return filtered;
    const code = cleanQuery.toUpperCase();
    return [
      {
        id: `code:${code}`,
        label: t("commands.openWork", { code }),
        description: t("commands.openWorkDescription"),
        icon: <FileAudio className="h-4 w-4" />,
        run: () => onOpenPath(`/${encodeURIComponent(code)}`),
      },
      ...filtered,
    ];
  }, [baseActions, cleanQuery, codeMatch, onOpenPath, t]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setActionBusy(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    onBusyChange?.(actionBusy !== null);
  }, [actionBusy, onBusyChange]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const runAction = async (index: number) => {
    const action = actions[index];
    if (!action || action.disabled || actionBusy) return;
    if (action.closeOnRun !== false) onOpenChange(false);
    try {
      const result = action.run();
      if (result instanceof Promise) {
        setActionBusy(action.id);
        await result;
      }
    } catch (error) {
      toast.notify(toastFromError(error, t("commands.failed")));
    } finally {
      setActionBusy(null);
    }
  };

  const paletteHeader = (
    <>
      <Search className="h-4 w-4 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, Math.max(0, actions.length - 1)));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void runAction(activeIndex);
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        placeholder={t("commands.searchPlaceholder")}
      />
      {!mobile && (
        <Button variant="ghost" size="icon" aria-label={t("commands.closePalette")} onClick={() => onOpenChange(false)}>
          <X className="h-4 w-4" />
        </Button>
      )}
    </>
  );

  const paletteBody = (
    <>
      {actions.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("commands.noMatch")}
        </div>
      ) : (
        actions.map((action, index) => (
          <button
            key={action.id}
            className={cx(
              "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm",
              action.disabled && "cursor-not-allowed opacity-55",
              index === activeIndex ? "bg-muted text-foreground" : "hover:bg-muted",
            )}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => void runAction(index)}
            disabled={action.disabled || actionBusy !== null}
          >
            <span className="text-muted-foreground">
              {actionBusy === action.id ? <Loader2 className="h-4 w-4 animate-spin" /> : action.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{action.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{action.description}</span>
            </span>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </button>
        ))
      )}
    </>
  );

  const paletteContent = mobile ? (
    <>
      <MobileSheetHeader>{paletteHeader}</MobileSheetHeader>
      <MobileSheetBody>{paletteBody}</MobileSheetBody>
    </>
  ) : (
    <>
      <div className="flex min-h-14 items-center gap-3 border-b px-4">{paletteHeader}</div>
      <div className="app-scroll min-h-0 flex-1 overflow-auto p-2">{paletteBody}</div>
    </>
  );

  if (mobile) {
    return (
      <MobileSheet
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel={t("commands.palette")}
        className="flex flex-col overflow-hidden p-0"
      >
        {paletteContent}
      </MobileSheet>
    );
  }

  if (!open) return null;

  return (
    <div
      className="visual-viewport-layer z-50 flex min-h-0 bg-background/55 p-2 backdrop-blur-sm sm:p-4 lg:block"
      onMouseDown={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("commands.palette")}
        className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden rounded-md border bg-card shadow-xl lg:mt-[10vh] lg:flex-none lg:max-h-[76vh]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {paletteContent}
      </div>
    </div>
  );
}

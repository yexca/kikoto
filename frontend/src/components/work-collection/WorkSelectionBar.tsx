import { Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/tailwindClassNames";

export type WorkSelectionState = "none" | "some" | "all";

// The header checkbox summarizes the current scope (normally the visible page)
// while the count reports every selected work, which may span earlier pages.
export function workSelectionState({
  selectedCount,
  scopeSelectableCount,
  scopeSelectedCount,
}: {
  selectedCount: number;
  scopeSelectableCount: number;
  scopeSelectedCount: number;
}): WorkSelectionState {
  if (scopeSelectableCount > 0 && scopeSelectedCount >= scopeSelectableCount) return "all";
  return selectedCount > 0 ? "some" : "none";
}

export function WorkSelectionBar({
  selectedCount,
  scopeSelectableCount,
  scopeSelectedCount,
  onSelectScope,
  onClear,
  onExit,
  children,
}: {
  selectedCount: number;
  scopeSelectableCount: number;
  scopeSelectedCount: number;
  onSelectScope: () => void;
  onClear: () => void;
  onExit: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const state = workSelectionState({ selectedCount, scopeSelectableCount, scopeSelectedCount });
  const toggleDisabled = scopeSelectableCount === 0 && selectedCount === 0;
  // A partial selection completes to the whole scope first; only a full
  // selection clears, so one click never discards work the user just picked.
  const toggle = () => {
    if (toggleDisabled) return;
    if (state === "all") onClear();
    else onSelectScope();
  };

  return (
    <div
      role="toolbar"
      aria-label={t("collection.selectionActions")}
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border bg-card p-1 text-sm"
    >
      <div
        className={cn(
          "order-1 flex min-h-11 items-center gap-2.5 rounded-md pl-2.5 pr-2",
          toggleDisabled ? "cursor-default" : "cursor-pointer hover:bg-muted/60",
        )}
        onClick={toggle}
      >
        <Checkbox
          checked={state === "all"}
          indeterminate={state === "some"}
          disabled={toggleDisabled}
          onCheckedChange={toggle}
          onClick={(event) => event.stopPropagation()}
          aria-label={state === "all" ? t("collection.clearSelection") : t("collection.selectAllOnPage")}
          title={state === "all" ? t("collection.clearSelection") : t("collection.selectAllOnPage")}
        />
        <span
          className={cn("select-none tabular-nums", selectedCount > 0 ? "font-medium" : "text-muted-foreground")}
          aria-live="polite"
        >
          {t("collection.selectedCount", { count: selectedCount })}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="order-2 ml-auto text-muted-foreground sm:order-3 sm:ml-0"
        aria-label={t("collection.exitSelectionMode")}
        title={t("collection.exitSelectionMode")}
        onClick={onExit}
      >
        <X className="h-4 w-4" />
      </Button>
      {children && (
        <div className="order-3 flex w-full items-center gap-1.5 px-1 pb-1 sm:order-2 sm:ml-auto sm:w-auto sm:p-0 [&>*]:flex-1 sm:[&>*]:flex-none">
          {children}
        </div>
      )}
    </div>
  );
}

export function WorkSelectionAction({
  icon,
  label,
  count,
  busy = false,
  disabled = false,
  className,
  onClick,
  ...buttonProps
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
} & Pick<ButtonProps, "aria-expanded">) {
  const { t } = useTranslation();
  const accessibleLabel = count === undefined ? label : t("collection.actionWithCount", { action: label, count });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("gap-1.5", className)}
      {...buttonProps}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      disabled={busy || disabled || count === 0}
      onClick={onClick}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      <span>{label}</span>
      {count !== undefined && (
        <span
          className="min-w-5 rounded-full bg-muted px-1.5 text-center text-2xs font-semibold tabular-nums leading-5 text-muted-foreground"
          aria-hidden="true"
        >
          {count}
        </span>
      )}
    </Button>
  );
}

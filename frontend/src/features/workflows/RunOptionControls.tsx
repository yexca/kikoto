import { AlertCircle, Info, Loader2, Play } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/tailwindClassNames";

/**
 * Labeled option. Rows place the label beside the control on wider screens and
 * stack them on phones; `stacked` keeps the label above for narrow surfaces
 * such as dialogs and popovers.
 */
export function OptionField({
  label,
  htmlFor,
  hint,
  stacked = false,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  stacked?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div
      className={cn(
        "grid min-w-0 gap-1.5",
        !stacked && "sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start sm:gap-x-8",
        className,
      )}
    >
      <Label
        className={cn(
          "text-sm font-medium",
          !stacked && "sm:flex sm:min-h-[var(--control-height-sm)] sm:items-center sm:text-muted-foreground",
        )}
        {...(htmlFor ? { htmlFor } : {})}
      >
        {label}
      </Label>
      <div className="grid min-w-0 content-start gap-1.5">
        {children}
        {hint && <p className="text-xs leading-5 text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

/** A single-choice button row sized like a compact field control. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={segmentedListClassName("h-[var(--control-height-sm)] gap-0.5 rounded-[var(--control-radius)] p-0.5")}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={segmentedItemClassName(selected, "h-full rounded-[calc(var(--control-radius)-2px)]")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A switch followed by a short description of what turning it on does. */
export function SwitchControl({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  /** Accessible name of the switch. */
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-h-[var(--control-height-sm)] min-w-0 items-center gap-3">
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} disabled={disabled} />
      {description && <span className="min-w-0 text-xs leading-5 text-muted-foreground">{description}</span>}
    </div>
  );
}

/** Places a workflow's run action in the page toolbar and its run options below the header. */
export type RunFormLayout = (parts: {
  run: ReactNode;
  actions?: ReactNode;
  options: ReactNode;
  optionsActions?: ReactNode;
}) => ReactNode;

export function WorkflowRunButton({
  running,
  disabled,
  onClick,
}: {
  running: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const label = running ? t("workflowPage.queueing") : t("workflowPage.run");
  return (
    <Button className="h-9 px-3 sm:min-w-24" aria-label={label} disabled={running || disabled} onClick={onClick}>
      {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

/** Explains why Run is unavailable, next to the inputs that resolve it. */
export function RunBlockerNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  );
}

/** Tells the viewer a value was filled in for them, so they check it before running. */
export function RunPrefillNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="note">
      <Info className="h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  );
}

/** Vertical rhythm for label-beside-control option rows. */
export function RunOptionRows({ children }: { children: ReactNode }) {
  return <div className="grid gap-4">{children}</div>;
}

import type { ReactNode } from "react";

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

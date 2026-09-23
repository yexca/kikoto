import type { ReactNode } from "react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/tailwindClassNames";

/** Labeled field container; the label names the control through its `htmlFor` or by wrapping it. */
export function OptionField({
  label,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={cn("grid min-w-0 content-start gap-1.5", className)}>
      <Label className="text-sm font-medium" {...(htmlFor ? { htmlFor } : {})}>
        {label}
      </Label>
      {children}
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
      className="flex h-[var(--control-height-sm)] w-fit max-w-full gap-0.5 overflow-x-auto rounded-[var(--control-radius)] bg-muted p-0.5"
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
            className={cn(
              "shrink-0 rounded-[calc(var(--control-radius)-2px)] px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              selected ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A switch with its label and description, aligned to the field grid rhythm. */
export function ToggleField({
  label,
  description,
  checked,
  onCheckedChange,
  switchLabel = label,
  disabled = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  switchLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">{label}</div>
        {description && <p className="text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      <Switch
        className="mt-0.5 shrink-0"
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={switchLabel}
        disabled={disabled}
      />
    </div>
  );
}

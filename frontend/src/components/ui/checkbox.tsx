import { Check, Minus } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked, indeterminate = false, onCheckedChange, onClick, className, disabled, ...props }, ref) => {
    const active = checked || indeterminate;
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? "mixed" : checked}
        disabled={disabled}
        data-state={indeterminate ? "indeterminate" : checked ? "checked" : "unchecked"}
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
          active ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted",
          className,
        )}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onCheckedChange(!active);
        }}
      >
        {indeterminate ? <Minus className="h-3.5 w-3.5" /> : checked ? <Check className="h-3.5 w-3.5" /> : null}
      </button>
    );
  },
);
Checkbox.displayName = "Checkbox";

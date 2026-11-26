import type { ReactNode } from "react";

import { cn } from "@/lib/tailwindClassNames";

export type FieldProps = {
  label: string;
  /** Muted text under the control. It sits inside the label, so it is part of the control's accessible name. */
  hint?: string;
  className?: string;
  /** One form control, which the wrapping `<label>` names. */
  children: ReactNode;
};

/** A form control under its label. Layout differences come from `className`. */
export function Field({ label, hint, className, children }: FieldProps) {
  return (
    <label className={cn("grid gap-1.5 text-sm", className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

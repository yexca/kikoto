import type { ReactNode } from "react";

import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/tailwindClassNames";

/** A labelled control with its hint outside the label, so the label stays the control's exact name. */
export function SettingsField({
  label,
  hint,
  hintId,
  hintClassName,
  children,
}: {
  label: string;
  hint?: string;
  hintId?: string;
  hintClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Field label={label} className="min-w-0">
        {children}
      </Field>
      {hint && (
        <p id={hintId} className={cn("text-xs leading-5 text-muted-foreground", hintClassName)}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function SettingsSwitchRow({
  title,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4">
      <div className={cn("min-w-0", disabled && "opacity-60")}>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </div>
      <Switch checked={checked} disabled={disabled} aria-label={title} onCheckedChange={onCheckedChange} />
    </div>
  );
}

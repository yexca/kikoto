import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "@/lib/tailwindClassNames";

/**
 * Grouped settings list: a quiet heading outside a single card whose rows are
 * separated by hairlines. Pages compose sections instead of nesting cards.
 */
export function SettingsSection({
  title,
  description,
  icon,
  action,
  footer,
  children,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className={cn("min-w-0 space-y-2.5", className)}>
      <div className="flex min-w-0 items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {icon && <span className="text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <div className="theme-card-surface min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground">
        <div className="divide-y">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/25 px-4 py-2.5">{footer}</div>
        )}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  htmlFor,
  children,
  className,
  stack = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
  className?: string;
  /** Places the control below the label at every width, for wide inputs. */
  stack?: boolean;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2.5 px-4 py-3",
        !stack && "sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        className,
      )}
    >
      <Label htmlFor={htmlFor} className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        {description && <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>}
      </Label>
      {children !== undefined && (
        <div className={cn("flex min-w-0 shrink-0 items-center gap-2", stack ? "w-full" : "sm:justify-end")}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Collapsible group for rarely changed settings; closed by default. */
export function SettingsDisclosure({
  title,
  description,
  defaultOpen = false,
  open,
  onToggle,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      className={cn("group/disclosure min-w-0", className)}
      open={open ?? defaultOpen}
      onToggle={(event) => onToggle?.((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/disclosure:rotate-90" />
        <span className="min-w-0 flex-1">
          <span className="block">{title}</span>
          {description && (
            <span className="mt-0.5 block text-xs font-normal leading-5 text-muted-foreground">{description}</span>
          )}
        </span>
      </summary>
      <div className="divide-y border-t">{children}</div>
    </details>
  );
}

/** Number input with a trailing unit, sized for a settings row. */
export function SettingsNumberInput({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  className,
}: {
  id?: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-[var(--control-height)] w-full overflow-hidden rounded-[var(--control-radius)] border border-input bg-background focus-within:ring-2 focus-within:ring-ring sm:w-40",
        className,
      )}
    >
      <input
        id={id}
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent px-3 text-right text-sm tabular-nums outline-none"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {unit && (
        <span className="flex items-center border-l bg-muted/60 px-3 text-xs text-muted-foreground">{unit}</span>
      )}
    </div>
  );
}

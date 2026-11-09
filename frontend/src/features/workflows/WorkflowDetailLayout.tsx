import type { ReactNode } from "react";

import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";

import { formatRelativeTime, formatTimestamp, parseWorkflowTimestamp } from "./runPresentation";

export function WorkflowHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h3 className="text-lg font-semibold leading-7">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap justify-end gap-2">{actions}</div>}
    </div>
  );
}

export function WorkflowSection({
  title,
  actions,
  children,
  label,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section className="min-w-0 space-y-2" aria-label={label}>
      <div className="flex min-h-9 items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {actions && <div className="-mr-2 flex flex-wrap justify-end gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Relative time with the absolute value available on hover. */
export function RelativeTime({ value, fallback, now }: { value: string | null; fallback: string; now?: number }) {
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const date = parseWorkflowTimestamp(value);
  if (!date) return <>{fallback}</>;
  return (
    <time dateTime={date.toISOString()} title={formatTimestamp(date, locale)}>
      {formatRelativeTime(date, locale, now)}
    </time>
  );
}

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/tailwindClassNames";

/**
 * The heading of a group of works: the title with an optional muted detail,
 * a count badge, a hairline to the end of the row, and an optional action at
 * the end. A description, when given, sits under the row.
 */
export function WorkSectionHeading({
  id,
  title,
  detail,
  icon,
  count,
  countLabel,
  description,
  action,
  className,
}: {
  /** Lets the section name itself with `aria-labelledby`. */
  id?: string;
  title: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  count?: number;
  /** Reads the count in words, such as "3 works", for assistive technology. */
  countLabel?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 space-y-0.5", className)}>
      <div className="flex min-h-8 min-w-0 items-center gap-2.5">
        <h3 id={id} className="flex min-w-0 shrink items-center gap-1.5 text-base font-semibold leading-6">
          {icon}
          <span className="min-w-0 truncate">{title}</span>
          {detail && <span className="shrink-0 text-sm font-normal text-muted-foreground">{detail}</span>}
        </h3>
        {count !== undefined && (
          <Badge variant="outline" className="h-5 shrink-0 px-1.5 py-0 tabular-nums" title={countLabel}>
            <span aria-hidden={countLabel ? true : undefined}>{count}</span>
            {countLabel && <span className="sr-only">{countLabel}</span>}
          </Badge>
        )}
        <span className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />
        {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

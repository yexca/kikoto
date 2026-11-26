import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The open shelf in one line: its icon, its name with any edit action, and a
 * caption with the result count and page. The shelf list already shows every
 * shelf's total, so the header carries no artwork, kind label, or statistics;
 * a description is the name's tooltip. The line never wraps, so switching
 * shelves never moves the results below.
 */
export function FavoriteShelfHeader({
  icon: Icon,
  title,
  description,
  caption,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Null while the result count is still unknown. */
  caption: string | null;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-9 min-w-0 items-center gap-2.5">
      <Icon className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <h2
        className="min-w-0 truncate text-xl font-semibold leading-8 tracking-tight"
        title={description ? `${title} · ${description}` : title}
      >
        {title}
      </h2>
      {actions}
      {caption === null ? (
        <span className="skeleton-reveal h-3 w-16 shrink-0 animate-pulse rounded bg-muted" aria-hidden="true" />
      ) : (
        <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-muted-foreground">{caption}</span>
      )}
    </header>
  );
}

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/tailwindClassNames";

/**
 * One status vocabulary for the line above a card: success for a work that is
 * available or in the library, primary for a work that is new or back, neutral
 * for what happened, and warning for a check that failed. Unread state is a
 * dot, never a badge.
 */
export type WorkCardStatusTone = "success" | "primary" | "neutral" | "warning";

const toneVariants = {
  success: "success",
  primary: "default",
  neutral: "secondary",
  warning: "warning",
} as const satisfies Record<WorkCardStatusTone, string>;

export function WorkCardStatusBadge({
  tone,
  className,
  children,
}: {
  tone: WorkCardStatusTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Badge variant={toneVariants[tone]} className={cn("h-5 shrink-0 gap-1 px-1.5 py-0 text-2xs", className)}>
      {children}
    </Badge>
  );
}

/** Marks what arrived since the last visit; the label is for assistive technology and the tooltip. */
export function WorkCardUnreadDot({ label }: { label: string }) {
  return (
    <span className="h-2 w-2 shrink-0 rounded-full bg-primary" title={label}>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The fixed-height line above a card that says why the work is in this view:
 * its status marks first, then a muted detail that truncates, and an optional
 * control at the end. It keeps its height when empty, so cards in a row stay
 * aligned whatever each one has to say.
 */
export function WorkCardContextStrip({
  children,
  detail,
  action,
}: {
  children?: ReactNode;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-1.5 px-1 text-xs">
      {children}
      {detail && (
        <span className="min-w-0 truncate text-muted-foreground" title={detail}>
          {detail}
        </span>
      )}
      {action && <span className="ml-auto flex shrink-0 items-center">{action}</span>}
    </div>
  );
}

/**
 * A card in a Discover view: the context strip above the card, with an
 * optional column before both, such as a rank.
 */
export function WorkCardContextItem({
  label,
  context,
  leading,
  children,
}: {
  /** The item's accessible name, usually the work's title. */
  label: string;
  context: ReactNode;
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li aria-label={label} className="flex min-w-0 gap-2 sm:gap-3">
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {context}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </li>
  );
}

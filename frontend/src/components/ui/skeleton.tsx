import type { HTMLAttributes } from "react";

import { cn } from "@/lib/tailwindClassNames";

export type SkeletonProps = HTMLAttributes<HTMLElement> & {
  /** `span` for a placeholder inside a line of text. */
  as?: "div" | "span";
  /**
   * Holds the placeholder back for its first 200ms (`skeleton-reveal`). Set it
   * on the outermost placeholder only: a block inside a revealed container is
   * already held back.
   */
  reveal?: boolean;
};

/**
 * One pulsing block of a loading placeholder. Size, shape, and tone come from
 * `className`, which overrides the default rounding and muted fill.
 */
export function Skeleton({ as: Element = "div", reveal = false, className, ...props }: SkeletonProps) {
  return (
    <Element
      aria-hidden="true"
      className={cn(reveal && "skeleton-reveal", "animate-pulse rounded bg-muted", className)}
      {...props}
    />
  );
}

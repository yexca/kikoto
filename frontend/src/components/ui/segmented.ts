import { cn } from "@/lib/tailwindClassNames";

/**
 * Segmented control treatment for tab strips and small view toggles: a muted
 * track with the selected segment raised onto the card surface.
 */
export function segmentedListClassName(className?: string) {
  return cn("app-scrollbar flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1", className);
}

export function segmentedItemClassName(active: boolean, className?: string) {
  return cn(
    "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
    active
      ? "bg-card text-foreground shadow-sm ring-1 ring-foreground/5 [&>svg]:text-primary"
      : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
    className,
  );
}

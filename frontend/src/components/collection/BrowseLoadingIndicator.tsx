import { Loader2 } from "lucide-react";

type BrowseLoadingIndicatorProps = {
  refreshing: boolean;
  label: string;
};

/** A non-blocking status indicator for refreshes that keep the current content visible. */
export function BrowseLoadingIndicator({ refreshing, label }: BrowseLoadingIndicatorProps) {
  if (!refreshing) return null;

  return (
    <span
      className="pointer-events-none fixed !mt-0 right-[max(1rem,var(--safe-area-right))] top-[calc(var(--header-height)+var(--safe-area-top)+0.5rem)] z-30 grid h-7 w-7 place-items-center rounded-full border bg-card/95 text-primary shadow-sm backdrop-blur-sm lg:right-6"
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
    >
      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    </span>
  );
}

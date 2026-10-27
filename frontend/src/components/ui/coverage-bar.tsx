import { cn } from "@/lib/tailwindClassNames";

/** How much of a list is covered, as a short bar beside its count; a full list turns success. */
export function CoverageBar({ count, total, className }: { count: number; total: number; className?: string }) {
  const ratio = total > 0 ? count / total : 0;
  return (
    <span className={cn("block h-1.5 overflow-hidden rounded-full bg-muted", className)} aria-hidden="true">
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
          ratio >= 1 ? "bg-success" : "bg-primary/70",
        )}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </span>
  );
}

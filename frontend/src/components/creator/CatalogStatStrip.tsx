import { cn } from "@/lib/tailwindClassNames";

export type CatalogStat = {
  key: string;
  label: string;
  count: number;
};

/**
 * Catalog counts for a creator's summary on one quiet line, each label
 * followed by its count. A count of zero is left out except the first. The
 * counts describe the whole catalog and only report; the works toolbar owns
 * filtering.
 */
export function CatalogStatStrip({ label, stats }: { label: string; stats: readonly CatalogStat[] }) {
  const shown = stats.filter((stat, index) => index === 0 || stat.count > 0);
  return (
    <dl
      role="group"
      aria-label={label}
      className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1 text-xs text-muted-foreground"
    >
      {shown.map((stat) => (
        <div
          key={stat.key}
          className="flex shrink-0 items-baseline gap-1 [&:not(:first-child)]:before:mr-1 [&:not(:first-child)]:before:text-border [&:not(:first-child)]:before:content-['·']"
        >
          <dt>{stat.label}</dt>
          <dd className={cn("font-semibold tabular-nums", stat.count > 0 && "text-foreground")}>{stat.count}</dd>
        </div>
      ))}
    </dl>
  );
}

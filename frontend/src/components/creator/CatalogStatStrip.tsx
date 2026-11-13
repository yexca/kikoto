import type { ReactNode } from "react";

import { AvailabilityMeter } from "@/components/creator/AvailabilityMeter";
import type { CreatorAvailability } from "@/components/creator/CreatorCard";
import { cn } from "@/lib/tailwindClassNames";

export type CatalogStat = {
  key: string;
  label: string;
  count: number;
};

/**
 * Catalog counts for a creator's summary with a short availability meter,
 * set off by a hairline instead of a box and only as wide as its content, and
 * an optional note below. The counts describe the whole catalog and only
 * report; the works toolbar owns filtering.
 */
export function CatalogStatStrip({
  label,
  stats,
  availability,
  availabilityLabel,
  note,
}: {
  label: string;
  stats: readonly CatalogStat[];
  availability: CreatorAvailability;
  availabilityLabel: string;
  note?: ReactNode;
}) {
  return (
    <div className="flex w-fit max-w-full flex-col gap-2 border-t border-border/70 pt-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 lg:gap-x-7">
        <dl role="group" aria-label={label} className="flex flex-wrap gap-x-5 gap-y-2 lg:gap-x-7">
          {stats.map((stat) => (
            <div key={stat.key} className="min-w-0 shrink-0">
              <dt className="whitespace-nowrap text-2xs font-medium text-muted-foreground">{stat.label}</dt>
              <dd
                className={cn(
                  "mt-0.5 text-sm font-semibold tabular-nums",
                  stat.count > 0 ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {stat.count}
              </dd>
            </div>
          ))}
        </dl>
        <AvailabilityMeter
          total={availability.total}
          local={availability.local}
          available={availability.available}
          label={availabilityLabel}
          className="h-1.5 w-32 lg:w-40"
        />
      </div>
      {/* A note that renders nothing leaves no gap behind. */}
      {note && <div className="text-xs leading-snug text-muted-foreground empty:hidden">{note}</div>}
    </div>
  );
}

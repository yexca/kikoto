import { AudioLines } from "lucide-react";
import { assetURL } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

/**
 * A small cover beside a work's title in a list row. Decorative: the title
 * next to it carries the meaning, so a work without a cover shows the same
 * placeholder icon as a work card.
 */
export function WorkCoverThumbnail({ url, className }: { url?: string; className?: string }) {
  return (
    <div
      className={cn(
        "grid aspect-[4/3] w-14 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary text-secondary-foreground ring-1 ring-foreground/5",
        className,
      )}
      aria-hidden="true"
    >
      {url ? (
        <img src={assetURL(url)} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
      ) : (
        <AudioLines className="h-4 w-4 opacity-50" />
      )}
    </div>
  );
}

import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { assetURL } from "@/lib/api";
import type { ListeningHistoryItem } from "@/lib/listeningApi";
import { cn } from "@/lib/tailwindClassNames";

/** A work's detail location and in-app navigation, composed by the app shell. */
export type ListeningHistoryWorkLink = { href: string | undefined; open: () => void };

export type ListeningHistoryWorkLinkFactory = (primaryCode: string) => ListeningHistoryWorkLink;

/**
 * A compact work card for listening reports: cover, code, title, and one line
 * of listening detail. It opens the work in place on a plain primary click and
 * leaves modified clicks to the browser.
 */
export function ListeningWorkCard({
  item,
  link,
  detail,
  rank,
  className,
}: {
  item: ListeningHistoryItem;
  link: ListeningHistoryWorkLink;
  detail: string;
  /** Position in a ranking, shown over the cover. */
  rank?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const title = item.title || item.primaryCode;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    link.open();
  };
  return (
    <a
      href={link.href}
      onClick={open}
      title={t("personal.history.openWork", { title })}
      className={cn(
        "theme-card-surface group flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="relative block aspect-[4/3] overflow-hidden bg-muted">
        {item.coverUrl ? (
          <img
            src={assetURL(item.coverUrl)}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:group-hover:scale-100"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="grid h-full place-items-center bg-secondary text-lg font-bold text-secondary-foreground">
            {item.primaryCode.slice(0, 2)}
          </span>
        )}
        {rank !== undefined && (
          <span
            className={cn(
              "absolute left-1.5 top-1.5 grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-xs font-semibold tabular-nums shadow-sm",
              rank === 1 ? "bg-primary text-primary-foreground" : "bg-background/85 text-foreground backdrop-blur-sm",
            )}
          >
            <span className="sr-only">{t("personal.history.rank", { rank })}</span>
            <span aria-hidden="true">{rank}</span>
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 pb-2 pt-1.5">
        <span className="truncate font-mono text-2xs text-muted-foreground">{item.primaryCode}</span>
        <span className="line-clamp-2 text-xs font-medium leading-snug">{title}</span>
        <span className="mt-auto pt-0.5 text-2xs leading-tight tabular-nums text-muted-foreground">{detail}</span>
      </span>
    </a>
  );
}

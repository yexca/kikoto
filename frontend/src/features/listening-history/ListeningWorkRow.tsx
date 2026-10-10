import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { assetURL } from "@/lib/api";
import type { ListeningHistoryItem } from "@/lib/listeningApi";
import { cn } from "@/lib/tailwindClassNames";

/** A work's detail location and in-app navigation, composed by the app shell. */
export type ListeningHistoryWorkLink = { href: string | undefined; open: () => void };

export type ListeningHistoryWorkLinkFactory = (primaryCode: string) => ListeningHistoryWorkLink;

/**
 * One work in a listening report: cover, title, code, and listening figures,
 * with an optional rank and a bar for the work's share of a ranking. It opens
 * the work in place on a plain primary click and leaves modified clicks to
 * the browser.
 */
export function ListeningWorkRow({
  item,
  link,
  value,
  detail,
  rank,
  barPercent,
}: {
  item: ListeningHistoryItem;
  link: ListeningHistoryWorkLink;
  /** The leading figure, such as the listening time. */
  value: string;
  detail?: ReactNode;
  /** Position in a ranking. */
  rank?: number;
  /** Bar length relative to the ranking's leader. */
  barPercent?: number;
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
      className="group flex min-h-14 min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {rank !== undefined && (
        <span
          className={cn(
            "w-5 shrink-0 text-center text-sm font-semibold tabular-nums",
            rank === 1 ? "text-primary" : "text-muted-foreground",
          )}
        >
          <span className="sr-only">{t("personal.history.rank", { rank })}</span>
          <span aria-hidden="true">{rank}</span>
        </span>
      )}
      <span className="relative block h-10 w-[3.25rem] shrink-0 overflow-hidden rounded-md bg-muted">
        {item.coverUrl ? (
          <img
            src={assetURL(item.coverUrl)}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="grid h-full place-items-center bg-secondary text-xs font-bold text-secondary-foreground">
            {item.primaryCode.slice(0, 2)}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-snug group-hover:text-primary">{title}</span>
        <span className="block truncate font-mono text-2xs text-muted-foreground">{item.primaryCode}</span>
        {barPercent !== undefined && (
          <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span className="block h-full rounded-full bg-primary/80" style={{ width: `${barPercent}%` }} />
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm font-medium tabular-nums">{value}</span>
        {detail && <span className="block text-2xs tabular-nums text-muted-foreground">{detail}</span>}
      </span>
    </a>
  );
}

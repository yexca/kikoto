import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { numberFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ListeningStatus } from "@/lib/api";
import type { FavoriteStatusFilterOption } from "./favoriteShelfModel";
import { FavoriteSearchInput } from "./FavoriteWorksControls";
import { FavoriteStatusChips } from "./FavoriteStatusTabs";

/**
 * The phone shelf controls, in the order of the phone Library toolbar: an
 * always-visible search field, a row that leads with the labeled sort and
 * keeps the view utilities at its end, the status chips, and a result caption
 * in place of a top pager.
 */
export function FavoriteMobileControls({
  query,
  placeholder,
  onQueryChange,
  sort,
  actions,
  status,
  result,
}: {
  query: string;
  placeholder: string;
  onQueryChange: (value: string) => void;
  /** Null on creator shelves, which only search. */
  sort: ReactNode;
  actions: ReactNode;
  status: {
    options: FavoriteStatusFilterOption[];
    value: ListeningStatus | "all";
    onChange: (value: ListeningStatus | "all") => void;
  } | null;
  /** Null while the result count is unknown or on creator shelves. */
  result: { count: number; page: number; totalPages: number } | null;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const format = numberFormat(resolvedLocale);
  return (
    <div className="space-y-2" data-toast-avoid>
      <FavoriteSearchInput
        value={query}
        placeholder={placeholder}
        onChange={onQueryChange}
        className="h-[var(--control-height)] w-full shadow-sm"
      />
      {sort && (
        <div className="flex min-h-11 items-center gap-1.5">
          {sort}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
        </div>
      )}
      {status && <FavoriteStatusChips {...status} />}
      {result && (
        <p className="flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-semibold text-foreground">
            {t("library.resultCount", { value: format.format(result.count) })}
          </span>
          {result.totalPages > 1 && (
            <>
              <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />
              <span className="shrink-0 tabular-nums">
                {t("library.resultPage", {
                  page: format.format(result.page),
                  totalPages: format.format(result.totalPages),
                })}
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

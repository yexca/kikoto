import { useTranslation } from "react-i18next";

import { numberFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";

/**
 * The toolbar caption of a creator's works: how many match, and from tablet
 * width the page when they span more than one. The bottom page bar turns the
 * pages.
 */
export function CreatorWorkCaption({ page, total, totalPages }: { page: number; total: number; totalPages: number }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const format = numberFormat(resolvedLocale).format;
  return (
    <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" role="status">
      <span className="truncate font-semibold text-foreground">
        {t("detailActions.workCount", { value: format(total) })}
      </span>
      {totalPages > 1 && (
        <span className="hidden shrink-0 items-center gap-2 tabular-nums sm:inline-flex">
          <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />
          {t("detailActions.workPage", { page: format(page), totalPages: format(totalPages) })}
        </span>
      )}
    </p>
  );
}

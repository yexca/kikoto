import { useTranslation } from "react-i18next";

import { numberFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";

/**
 * The toolbar caption of a creator's works: from tablet width, the page when
 * they span more than one. The creator's own summary or tab states the work
 * count, and the bottom page bar turns the pages.
 */
export function CreatorWorkCaption({ page, totalPages }: { page: number; totalPages: number }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const format = numberFormat(resolvedLocale).format;
  if (totalPages <= 1) return null;
  return (
    <p className="hidden min-w-0 text-xs tabular-nums text-muted-foreground sm:block" role="status">
      {t("detailActions.workPage", { page: format(page), totalPages: format(totalPages) })}
    </p>
  );
}

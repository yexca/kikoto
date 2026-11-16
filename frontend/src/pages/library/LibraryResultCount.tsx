import { useTranslation } from "react-i18next";

import { numberFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";

/**
 * The number of works a wide-layout view holds, stated above results that fit
 * one page, where a page bar would have nothing to turn. Null renders the
 * line empty so the grid keeps its place while the count loads.
 */
export function LibraryResultCount({ value }: { value: number | null }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  return (
    <p className="min-h-5 px-0.5 text-xs text-muted-foreground" role="status">
      {value !== null && t("library.resultCount", { value: numberFormat(resolvedLocale).format(value) })}
    </p>
  );
}

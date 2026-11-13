import { useTranslation } from "react-i18next";

import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { numberFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";

type CreatorWorkResultsProps = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

/**
 * The phone caption of a creator's works: how many there are, and the page
 * when they span more than one. The bottom page bar turns the pages.
 */
export function CreatorWorkCaption({ page, total, totalPages }: Omit<CreatorWorkResultsProps, "pageSize">) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const format = numberFormat(resolvedLocale).format;
  return (
    <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" role="status">
      <span className="truncate font-semibold text-foreground">
        {t("detailActions.workCount", { value: format(total) })}
      </span>
      {totalPages > 1 && (
        <>
          <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />
          <span className="shrink-0 tabular-nums">
            {t("detailActions.workPage", { page: format(page), totalPages: format(totalPages) })}
          </span>
        </>
      )}
    </p>
  );
}

/**
 * The wide-layout line above a creator's works: the top page bar when the
 * works span more than one page, otherwise only their count, since a page bar
 * would have nothing to turn.
 */
export function CreatorWorkResultsBar({
  page,
  pageSize,
  total,
  totalPages,
  refreshing,
  refreshingLabel,
  onPageChange,
}: CreatorWorkResultsProps & {
  refreshing?: boolean;
  refreshingLabel?: string;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  return (
    <div className="hidden lg:block">
      {totalPages > 1 ? (
        <WorkCollectionPagination
          placement="top"
          page={page}
          pageSize={pageSize}
          totalItems={total}
          totalPages={totalPages}
          compactMobile
          refreshing={refreshing}
          refreshingLabel={refreshingLabel}
          onPageChange={onPageChange}
        />
      ) : (
        <p className="min-h-5 px-0.5 text-xs text-muted-foreground" role="status">
          {t("detailActions.workCount", { value: numberFormat(resolvedLocale).format(total) })}
        </p>
      )}
    </div>
  );
}

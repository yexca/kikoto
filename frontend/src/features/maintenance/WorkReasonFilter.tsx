import { useTranslation } from "react-i18next";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { cx } from "@/lib/classNames";

export type CatalogWorkReason = "catalog" | "all" | "metadata" | "no_source";

export const catalogWorkReasons: readonly CatalogWorkReason[] = ["catalog", "all", "metadata", "no_source"];

// Works in these filters need an operator; their counts take the attention color.
const attentionReasons = new Set<CatalogWorkReason>(["all", "metadata", "no_source"]);

const reasonLabels: Record<CatalogWorkReason, string> = {
  catalog: "workManagement.all",
  all: "workMaintenance.all",
  metadata: "workMaintenance.metadata",
  no_source: "workMaintenance.noSource",
};

/**
 * Segmented filter over the catalog work views. Each option is one `reason`
 * of the maintenance read, so links that name a reason select it here.
 */
export function WorkReasonFilter({
  reasons,
  selected,
  counts,
  onSelect,
}: {
  reasons: readonly CatalogWorkReason[];
  selected: CatalogWorkReason;
  /** Works each filter lists; a missing count shows none. */
  counts: Partial<Record<CatalogWorkReason, number>>;
  onSelect: (reason: CatalogWorkReason) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("workManagement.dlsiteFilter")}
      className={segmentedListClassName("![scrollbar-width:none] [&::-webkit-scrollbar]:hidden")}
    >
      {reasons.map((reason) => {
        const active = reason === selected;
        const count = counts[reason];
        const descriptionId = `metadata-filter-${reason}-count`;
        return (
          <button
            key={reason}
            type="button"
            aria-pressed={active}
            aria-describedby={count === undefined ? undefined : descriptionId}
            className={segmentedItemClassName(active, "h-9 sm:h-8")}
            onClick={() => onSelect(reason)}
          >
            {t(reasonLabels[reason])}
            {count !== undefined && (
              <>
                <span id={descriptionId} hidden>
                  {t("workManagement.workCount", { count })}
                </span>
                <span
                  aria-hidden="true"
                  className={cx(
                    "-ml-1 rounded-full px-1.5 text-xs tabular-nums leading-5",
                    attentionReasons.has(reason) && count > 0
                      ? "bg-warning-surface text-warning-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

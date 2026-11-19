import { ListFilter } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FloatingSelect } from "@/components/ui/floating-select";
import { cx } from "@/lib/classNames";

export type CatalogWorkReason = "catalog" | "all";

export const catalogWorkReasons: readonly CatalogWorkReason[] = ["catalog", "all"];

const reasonLabels: Record<CatalogWorkReason, string> = {
  catalog: "workManagement.all",
  all: "workMaintenance.all",
};

/**
 * Toolbar select between every catalog work and the works that need
 * attention. Each option is one `reason` of the maintenance read; the rows
 * name what each work needs. The trigger names the selected filter (on phones
 * only its count shows) and turns primary while it narrows the list; while it
 * does not, a dot keeps works that need attention in sight.
 */
export function WorkReasonFilter({
  selected,
  counts,
  onSelect,
}: {
  selected: CatalogWorkReason;
  /** Works each filter lists; a missing count shows none. */
  counts: Partial<Record<CatalogWorkReason, number>>;
  onSelect: (reason: CatalogWorkReason) => void;
}) {
  const { t } = useTranslation();
  const count = (reason: CatalogWorkReason) => {
    const value = counts[reason];
    if (value === undefined) return null;
    return (
      <>
        <span className="sr-only">, {t("workManagement.workCount", { count: value })}</span>
        <span
          aria-hidden="true"
          className={cx(
            "shrink-0 rounded-full px-1.5 text-xs font-normal tabular-nums leading-5",
            reason === "all" && value > 0 ? "bg-warning-surface text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {value}
        </span>
      </>
    );
  };
  const filtered = selected === "all";
  const pending = !filtered && (counts.all ?? 0) > 0;
  return (
    <FloatingSelect
      value={selected}
      options={catalogWorkReasons.map((reason) => ({
        value: reason,
        label: (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">{t(reasonLabels[reason])}</span>
            {count(reason)}
          </span>
        ),
      }))}
      ariaLabel={t("workManagement.dlsiteFilter")}
      triggerLabel={
        <span className="flex min-w-0 items-center gap-1.5">
          <ListFilter className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate max-sm:sr-only">{t(reasonLabels[selected])}</span>
          {count(selected)}
          {pending && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}
        </span>
      }
      onValueChange={(value) => onSelect(value as CatalogWorkReason)}
      className={cx(
        "h-8 w-auto max-w-[16rem] gap-1.5 px-2.5 text-xs font-medium",
        filtered ? "border-primary/40 bg-primary/10 text-primary" : "bg-background text-muted-foreground",
      )}
      contentClassName="min-w-[13rem]"
    />
  );
}

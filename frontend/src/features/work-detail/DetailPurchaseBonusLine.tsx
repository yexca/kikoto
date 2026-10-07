import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { WorkPurchaseBonus, WorkPurchaseBonusWork } from "@/lib/api";
import { openWorkCodeRoute } from "@/features/work-detail/workDetailShared";

const labelClassName = "shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground";
const linkClassName =
  "min-w-0 truncate rounded-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline";

/**
 * The purchase bonus relation of a work: the parent a bonus belongs to, and
 * the bonuses in the library that belong to this work's family.
 */
export function DetailPurchaseBonusLine({
  purchaseBonus,
  purchaseBonuses,
}: {
  purchaseBonus?: WorkPurchaseBonus | null;
  purchaseBonuses?: WorkPurchaseBonusWork[] | null;
}) {
  const { t } = useTranslation();
  const parent = purchaseBonus?.status === "linked" && purchaseBonus.parentCode ? purchaseBonus : null;
  const bonuses = purchaseBonuses ?? [];
  if (!parent && bonuses.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      {parent && (
        <div
          className="flex min-w-0 items-baseline gap-3"
          role="group"
          aria-label={t("libraryDetail.purchaseBonusFor")}
        >
          <span className={labelClassName}>{t("libraryDetail.purchaseBonusFor")}</span>
          {parent.parentWork ? (
            <button
              type="button"
              className={linkClassName}
              title={parent.parentWork.title}
              onClick={() => openWorkCodeRoute(parent.parentWork?.code ?? "")}
            >
              {parent.parentWork.title || parent.parentWork.code}
            </button>
          ) : (
            <span className="inline-flex min-w-0 items-baseline gap-1.5">
              <span className="font-mono text-xs">{parent.parentCode}</span>
              {parent.url && (
                <a
                  href={parent.url}
                  target="_blank"
                  rel="noreferrer"
                  className="self-center rounded text-muted-foreground hover:text-foreground"
                  aria-label={t("libraryDetail.openMetadataLinkSource", { code: parent.parentCode })}
                  title={t("libraryDetail.openMetadataLinkSource", { code: parent.parentCode })}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </span>
          )}
        </div>
      )}
      {bonuses.length > 0 && (
        <div className="flex min-w-0 items-baseline gap-3">
          <span className={labelClassName}>{t("libraryDetail.purchaseBonuses")}</span>
          <ul
            className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1"
            aria-label={t("libraryDetail.purchaseBonuses")}
          >
            {bonuses.map((bonus, index) => (
              <li key={bonus.id} className="inline-flex min-w-0 items-baseline">
                <button
                  type="button"
                  className={linkClassName}
                  title={bonus.title}
                  onClick={() => openWorkCodeRoute(bonus.code)}
                >
                  {bonus.title || bonus.code}
                </button>
                {index < bonuses.length - 1 && <span className="ml-1 text-muted-foreground">·</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

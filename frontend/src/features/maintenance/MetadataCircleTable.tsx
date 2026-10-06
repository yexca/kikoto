import { useTranslation } from "react-i18next";
import type { MetadataCircle } from "@/lib/api";
import { MetadataEntryCover } from "./MetadataEntryCover";
import {
  MetadataActionsCell,
  MetadataActionsHeader,
  MetadataManageButton,
  metadataBodyClassName,
  metadataHeadClassName,
  metadataRowClassName,
  metadataTableClassName,
} from "./MetadataEntryTable";

/**
 * Circles keyed by DLsite maker id, like tags by id, so the list reads the
 * same whatever names anyone authored. Maker ids a merge brought along sit
 * under the primary one; a circle known only from a remote source has no code
 * and shows its Kikoto id. The manage action stays pinned to the visible edge.
 */
export function MetadataCircleTable({
  circles,
  onManage,
}: {
  circles: MetadataCircle[];
  onManage: (circle: MetadataCircle) => void;
}) {
  const { t } = useTranslation();
  return (
    <table className={metadataTableClassName} aria-label={t("metadataEntries.circles")}>
      <thead className={metadataHeadClassName}>
        <tr className="h-10">
          <th scope="col" className="py-2 pl-4 pr-3 font-medium">
            {t("metadataEntries.code")}
          </th>
          <th scope="col" className="min-w-48 px-3 py-2 font-medium">
            {t("metadataEntries.name")}
          </th>
          <th scope="col" className="min-w-36 px-3 py-2 font-medium">
            {t("metadataEntries.knownNames")}
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            {t("metadataEntries.workCount")}
          </th>
          <MetadataActionsHeader />
        </tr>
      </thead>
      <tbody className={metadataBodyClassName}>
        {circles.map((circle) => {
          const mergedCodes = circle.externalIds.filter((code) => code !== circle.code);
          const renamed = circle.manualName !== "" && circle.manualName !== circle.providerName;
          return (
            <tr key={circle.id} className={`${metadataRowClassName} align-middle`}>
              <th scope="row" className="whitespace-nowrap py-2 pl-4 pr-3 font-mono text-xs font-medium tabular-nums">
                <span className="block">{circle.code || `#${circle.id}`}</span>
                {mergedCodes.map((code) => (
                  <span key={code} className="block font-normal text-muted-foreground">
                    {code}
                  </span>
                ))}
              </th>
              <td className="px-3 py-2">
                <div className="flex min-w-0 items-center gap-3">
                  <MetadataEntryCover url={circle.coverUrl} name={circle.displayName} />
                  <div className="min-w-0">
                    <span className="block font-medium">{circle.displayName}</span>
                    {renamed && (
                      <span className="block text-xs text-muted-foreground">
                        {t("metadataEntries.providerName")}: {circle.providerName}
                      </span>
                    )}
                  </div>
                </div>
              </td>
              <td className="max-w-sm px-3 py-2 text-muted-foreground">
                {circle.aliases.map((value) => value.alias).join(" · ") || (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{circle.workCount}</td>
              <MetadataActionsCell>
                <MetadataManageButton
                  label={t("metadataEntries.manageFor", { name: circle.displayName })}
                  onClick={() => onManage(circle)}
                />
              </MetadataActionsCell>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

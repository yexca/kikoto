import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { MetadataCircle } from "@/lib/api";
import { MetadataEntryCover } from "./MetadataEntryCover";

/**
 * Circles keyed by DLsite maker id, like tags by id, so the list reads the
 * same whatever names anyone authored. Maker ids a merge brought along sit
 * under the primary one; a circle known only from a remote source has no code
 * and shows its Kikoto id. Manage stays pinned to the visible edge.
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
    <table className="w-full text-left text-sm" aria-label={t("metadataEntries.circles")}>
      <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
        <tr>
          <th className="px-3 py-2">{t("metadataEntries.code")}</th>
          <th className="min-w-48 px-3 py-2">{t("metadataEntries.name")}</th>
          <th className="min-w-36 px-3 py-2">{t("metadataEntries.knownNames")}</th>
          <th className="px-3 py-2">{t("metadataEntries.workCount")}</th>
          <th className="sticky right-0 bg-card px-3 py-2">
            <span className="sr-only">{t("metadataEntries.manage")}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {circles.map((circle) => {
          const mergedCodes = circle.externalIds.filter((code) => code !== circle.code);
          const renamed = circle.manualName !== "" && circle.manualName !== circle.providerName;
          return (
            <tr key={circle.id} className="border-b align-middle last:border-0">
              <th scope="row" className="whitespace-nowrap px-3 py-3 font-medium tabular-nums">
                <span className="block">{circle.code || `#${circle.id}`}</span>
                {mergedCodes.map((code) => (
                  <span key={code} className="block text-xs font-normal text-muted-foreground">
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
              <td className="max-w-sm px-3 py-3 text-muted-foreground">
                {circle.aliases.map((value) => value.alias).join(" · ") || "—"}
              </td>
              <td className="px-3 py-3 tabular-nums">{circle.workCount}</td>
              <td className="sticky right-0 bg-card px-3 py-3 text-right">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t("metadataEntries.manageFor", { name: circle.displayName })}
                  onClick={() => onManage(circle)}
                >
                  {t("metadataEntries.manage")}
                </Button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

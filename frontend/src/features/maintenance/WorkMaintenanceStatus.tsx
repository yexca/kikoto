import { CheckCircle2, Cloud, CloudDownload, HardDrive, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { MaintenanceWork } from "@/lib/api";

/** Whether a metadata retry can be queued for a row: an issue not already retrying, or a first sync. */
export function canRetryMetadata(work: MaintenanceWork) {
  return work.metadataIssues.some((issue) => !issue.retrying) || (work.metadataNotSynced && !work.metadataSyncing);
}

/** The work a metadata retry queues: the edition with a DLsite issue, or the never-synced family itself. */
export function metadataRetryWorkId(work: MaintenanceWork) {
  const item = work.metadataIssues.find((issue) => issue.providerCode === "dlsite" && !issue.retrying);
  if (item) return item.workId;
  return work.metadataNotSynced && !work.metadataSyncing ? work.id : null;
}

/** Whether the row needs any attention: a metadata issue, a first sync, or no available source. */
export function workNeedsAttention(work: MaintenanceWork) {
  return work.metadataIssues.length > 0 || work.metadataNotSynced || work.sourceTier === "none";
}

const attentionBadgeClassName = "px-1.5 py-0 text-[11px]";
const quietClassName = "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground";

/**
 * Whether the row's metadata is complete. Complete metadata, including what a
 * remote source filled, reads as quiet text so attention stands out; a missing
 * or failed sync takes the attention color. Without metadata access the state
 * is unknown and shows a dash.
 */
export function MetadataStatus({ work, known }: { work: MaintenanceWork; known: boolean }) {
  const { t } = useTranslation();
  if (!known) return <span className="text-muted-foreground">—</span>;
  const retrying = work.metadataIssues.some((issue) => issue.retrying);
  const remoteMetadata = work.remoteMetadataSource
    ? t("workMaintenance.remoteMetadata", { source: work.remoteMetadataSource })
    : "";
  return (
    <>
      {work.metadataIssues.length > 0 ? (
        <Badge variant="warning" className={attentionBadgeClassName}>
          {t("workMaintenance.metadata")}
        </Badge>
      ) : work.metadataNotSynced ? (
        <Badge variant="warning" className={attentionBadgeClassName}>
          {t("workMaintenance.notSynced")}
        </Badge>
      ) : remoteMetadata ? (
        <span className={quietClassName} title={remoteMetadata}>
          <CloudDownload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{remoteMetadata}</span>
        </span>
      ) : (
        <span className={quietClassName}>
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("workMaintenance.statusComplete")}
        </span>
      )}
      {(retrying || work.metadataSyncing) && (
        <span role="status" className="flex items-center gap-1.5 text-xs text-primary">
          <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t(retrying ? "metadataIssues.retrying" : "workMaintenance.syncing")}
        </span>
      )}
    </>
  );
}

/** The best source the family is available from: local before remote, both quiet; none needs attention. */
export function SourceStatus({ tier }: { tier: MaintenanceWork["sourceTier"] }) {
  const { t } = useTranslation();
  if (tier === "none")
    return (
      <Badge variant="warning" className={attentionBadgeClassName}>
        {t("workMaintenance.noSource")}
      </Badge>
    );
  const Icon = tier === "local" ? HardDrive : Cloud;
  return (
    <span className={quietClassName}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {t(tier === "local" ? "workMaintenance.sourceLocal" : "workMaintenance.sourceRemote")}
    </span>
  );
}

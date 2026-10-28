import { Activity, ExternalLink, GitFork, HardDriveDownload, Loader2, RefreshCw, Trash2 } from "lucide-react";

import { openWorkDetail } from "@/app/workDetailNavigation";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import i18n, { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatTimestamp, parseWorkflowTimestamp } from "@/features/workflows/runPresentation";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { Modal } from "@/features/workflows/WorkflowPanelParts";
import { assetURL, type AvailabilityWatchTarget } from "@/lib/api";
import { metadataTagLanguages } from "@/lib/metadataTagModel";

import { watchTargetStateLabel, type WatchCardPermissions } from "./AvailabilityWatchTargetCard";
import {
  isAvailableTarget,
  watchTargetActionCode,
  watchTargetAllows,
  watchTargetGroup,
  watchTargetRun,
} from "./availabilityWatchModel";
import { useArmedConfirm } from "./useArmedConfirm";
import type { WatchTargetActions } from "./useWatchTargetActions";

function stateBadgeVariant(target: AvailabilityWatchTarget): BadgeProps["variant"] {
  const group = watchTargetGroup(target);
  if (group === "failed" || watchTargetRun(target)?.state === "failed") return "warning";
  return group === "available" || group === "inLibrary" ? "success" : "secondary";
}

function editionLanguageLabel(language: string) {
  const known = metadataTagLanguages.find(([code]) => code !== "" && code === language.trim().toLowerCase());
  return known ? i18n.t(known[1]) : language.toUpperCase();
}

/**
 * One watched code's family: every known edition, which one a remote source
 * offers, and the actions for the target: Track and Fetch of the edition
 * found, Check now, and Remove.
 */
export function AvailabilityWatchFamilyDialog({
  target,
  sourceName,
  permissions,
  actions,
  onClose,
  onChanged,
}: {
  target: AvailabilityWatchTarget;
  sourceName: string;
  /** The account's permissions on the watch, or null where the view is read-only. */
  permissions: WatchCardPermissions | null;
  actions: WatchTargetActions;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const confirm = useArmedConfirm<"remove">();
  const available = isAvailableTarget(target);
  const availableCode = watchTargetActionCode(target);
  const checkedAt = parseWorkflowTimestamp(target.lastCheckedAt);
  const runId = watchTargetRun(target)?.runId ?? null;
  const busy = actions.busy !== null;

  const open = () => {
    if (!target.availableSourceId) return;
    openWorkDetail(
      { kind: "remote-only", sourceId: target.availableSourceId, remoteCode: availableCode },
      { returnTo: watchTargetLocation(target.id), returnLabel: workflowCopy("backToAvailabilityWatch") },
    );
  };
  const remove = () => {
    if (confirm.armed !== "remove") {
      confirm.arm("remove");
      return;
    }
    confirm.disarm();
    actions.removeOne(target);
    onClose();
  };

  const facts: [string, string][] = [
    [workflowCopy("availableAs"), available ? availableCode : "—"],
    [workflowCopy("remoteSource"), available && sourceName ? sourceName : "—"],
    [workflowCopy("lastChecked"), checkedAt ? formatTimestamp(checkedAt, locale) : workflowCopy("never")],
  ];

  return (
    <Modal title={workflowCopy("workFamilyTitle", { workCode: target.workCode })} onClose={onClose} dismissible>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          {target.coverUrl && (
            <img
              src={assetURL(target.coverUrl)}
              alt=""
              className="aspect-[4/3] w-24 shrink-0 rounded-md bg-secondary object-cover ring-1 ring-foreground/5"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-mono text-sm font-semibold">{target.workCode}</div>
            {target.title && <div className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{target.title}</div>}
          </div>
          <Badge variant={stateBadgeVariant(target)}>{watchTargetStateLabel(target)}</Badge>
        </div>
        {target.lastError && (
          <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
            {target.lastError}
          </p>
        )}

        <dl className="grid gap-x-6 gap-y-3 rounded-md border bg-muted/25 px-3 py-2.5 sm:grid-cols-3">
          {facts.map(([term, detail]) => (
            <div key={term} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{term}</dt>
              <dd className="mt-0.5 truncate text-sm font-medium" title={detail}>
                {detail}
              </dd>
            </div>
          ))}
        </dl>

        <section className="space-y-2" aria-labelledby="availability-watch-family-editions">
          <div>
            <h3 id="availability-watch-family-editions" className="text-sm font-medium">
              {workflowCopy("familyEditions")}
            </h3>
            <p className="text-xs text-muted-foreground">{workflowCopy("familyEditionsDescription")}</p>
          </div>
          {target.family.length === 0 ? (
            <p className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
              {target.lastCheckedAt ? workflowCopy("familyUnknown") : workflowCopy("familyPending")}
            </p>
          ) : (
            <ul className="divide-y rounded-md border bg-card text-sm">
              {target.family.map((member) => (
                <li key={member.code} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-xs font-semibold">{member.code}</span>
                      {member.language && (
                        <span className="text-xs text-muted-foreground">{editionLanguageLabel(member.language)}</span>
                      )}
                    </div>
                    <div className="truncate text-sm" title={member.title}>
                      {member.title || (
                        <span className="text-muted-foreground">{workflowCopy("editionWithoutMetadata")}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {member.code === target.workCode && <Badge variant="outline">{workflowCopy("watched")}</Badge>}
                    {member.canonical && <Badge variant="secondary">{workflowCopy("original")}</Badge>}
                    {available && member.code === availableCode && (
                      <Badge variant="success">{workflowCopy("availabilityState.available")}</Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {permissions && (
            <>
              <Button
                size="sm"
                variant={confirm.armed === "remove" ? "destructive" : "ghost"}
                onClick={remove}
                disabled={!permissions.manage || busy}
                title={permissions.manage ? undefined : workflowCopy("watchView.needsManagePermission")}
              >
                {actions.busy === "remove" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                {confirm.armed === "remove" ? workflowCopy("confirmRemoveFromWatch") : workflowCopy("removeFromWatch")}
              </Button>
              {confirm.armed === "remove" && (
                <Button size="sm" variant="ghost" onClick={confirm.disarm}>
                  {workflowCopy("cancel")}
                </Button>
              )}
            </>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {runId && (
              <Button
                size="sm"
                variant="ghost"
                title={workflowCopy("openRelatedActivity")}
                onClick={() => openActivityRunID(runId)}
              >
                <Activity className="h-4 w-4" />
                {workflowCopy("activity")}
              </Button>
            )}
            {available && (
              <Button size="sm" variant="outline" onClick={open} disabled={!target.availableSourceId}>
                <ExternalLink className="h-4 w-4" />
                {workflowCopy("open")}
              </Button>
            )}
            {permissions && watchTargetAllows(target, "check") && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  actions.check([target.id]);
                  onChanged();
                }}
                disabled={!permissions.manage || busy}
                title={permissions.manage ? undefined : workflowCopy("watchView.needsManagePermission")}
              >
                <RefreshCw className="h-4 w-4" />
                {workflowCopy("watchView.checkNow")}
              </Button>
            )}
            {permissions && available && !target.inLibrary && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => actions.track([target])}
                  disabled={!permissions.track || !watchTargetAllows(target, "track") || busy}
                  title={permissions.track ? undefined : workflowCopy("watchView.needsTrackPermission")}
                >
                  <GitFork className="h-4 w-4" />
                  {workflowCopy("watchView.trackCode", { code: availableCode })}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    actions.fetch([target]);
                  }}
                  disabled={!permissions.fetch || !watchTargetAllows(target, "fetch") || busy}
                  title={permissions.fetch ? undefined : workflowCopy("watchView.needsFetchPermission")}
                >
                  <HardDriveDownload className="h-4 w-4" />
                  {workflowCopy("watchView.fetchCode", { code: availableCode })}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** The Watch view of the page showing the pool, with this target's family open. */
function watchTargetLocation(targetId: number) {
  const params = new URLSearchParams(window.location.search);
  params.set("view", "watch");
  params.set("target", String(targetId));
  return `${window.location.pathname}?${params}`;
}

function openActivityRunID(runID: number) {
  window.history.pushState({}, "", `/workflows?activity=1&run=${runID}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

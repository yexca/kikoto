import { Activity, ExternalLink, GitBranchPlus, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

import { openWorkDetail } from "@/app/workDetailNavigation";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import i18n, { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatTimestamp, parseWorkflowTimestamp } from "@/features/workflows/runPresentation";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { Modal } from "@/features/workflows/WorkflowPanelParts";
import { api, assetURL, type AvailabilityWatchTarget } from "@/lib/api";
import { metadataTagLanguages } from "@/lib/metadataTagModel";

import { isAvailableTarget } from "./availabilityWatchModel";
import { useArmedConfirm } from "./useArmedConfirm";

export function availabilityWatchStateLabel(target: AvailabilityWatchTarget) {
  switch (target.state) {
    case "ready":
      return workflowCopy("availabilityState.available");
    case "action_queued":
      return workflowCopy("availabilityState.actionQueued");
    case "completed":
      return workflowCopy("dispatched");
    case "error":
      return workflowCopy("availabilityState.checkFailed");
    default:
      return target.lastCheckedAt
        ? workflowCopy("availabilityState.notAvailable")
        : workflowCopy("availabilityState.notChecked");
  }
}

function stateBadgeVariant(target: AvailabilityWatchTarget): BadgeProps["variant"] {
  if (target.state === "error" || target.lastError) return "warning";
  return isAvailableTarget(target) ? "success" : "secondary";
}

function editionLanguageLabel(language: string) {
  const known = metadataTagLanguages.find(([code]) => code !== "" && code === language.trim().toLowerCase());
  return known ? i18n.t(known[1]) : language.toUpperCase();
}

/**
 * One watched code's family: every known edition, which one a remote source
 * offers, and the actions for that edition.
 */
export function AvailabilityWatchFamilyDialog({
  target,
  sourceName,
  readOnly,
  onClose,
  onChanged,
}: {
  target: AvailabilityWatchTarget;
  sourceName: string;
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const confirm = useArmedConfirm<"remove">();
  const [busy, setBusy] = useState<"track" | "remove" | null>(null);
  const available = isAvailableTarget(target);
  const availableCode = target.availableCode || target.workCode;
  const checkedAt = parseWorkflowTimestamp(target.lastCheckedAt);
  const runId = target.fetchRunId ?? target.trackRunId;

  const open = () => {
    if (!target.availableSourceId) return;
    openWorkDetail(
      { kind: "remote-only", sourceId: target.availableSourceId, remoteCode: availableCode },
      {
        returnTo: `/workflows?workflow=availability_watch&target=${target.id}`,
        returnLabel: workflowCopy("backToAvailabilityWatch"),
      },
    );
  };
  const track = async () => {
    setBusy("track");
    try {
      const result = await api.trackAvailabilityWatchTarget(target.id);
      toast.success(workflowCopy("trackRunQueued", { runId: result.runId }));
      onChanged();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("trackTargetFailed", { workCode: availableCode })));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (confirm.armed !== "remove") {
      confirm.arm("remove");
      return;
    }
    confirm.disarm();
    setBusy("remove");
    try {
      await api.removeAvailabilityWatchTarget(target.id);
      toast.success(workflowCopy("removedFromWatch", { workCode: target.workCode }));
      onChanged();
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("removeTargetFailed", { workCode: target.workCode })));
      setBusy(null);
    }
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
          <Badge variant={stateBadgeVariant(target)}>{availabilityWatchStateLabel(target)}</Badge>
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
          {!readOnly && (
            <>
              <Button
                size="sm"
                variant={confirm.armed === "remove" ? "destructive" : "ghost"}
                onClick={() => void remove()}
                disabled={busy !== null}
              >
                {busy === "remove" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
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
              <>
                <Button size="sm" variant="outline" onClick={open} disabled={!target.availableSourceId}>
                  <ExternalLink className="h-4 w-4" />
                  {workflowCopy("open")}
                </Button>
                <Button size="sm" onClick={() => void track()} disabled={readOnly || busy !== null}>
                  {busy === "track" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GitBranchPlus className="h-4 w-4" />
                  )}
                  {workflowCopy("track")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function openActivityRunID(runID: number) {
  window.history.pushState({}, "", `/workflows?activity=1&run=${runID}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

import { ListX, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toastFromError, useToast } from "@/components/ui/toast";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import {
  api,
  type AvailabilityWatch,
  type AvailabilityWatchActionResult,
  type AvailabilityWatchTarget,
} from "@/lib/api";

import { WATCH_ACTION_MAX_TARGETS } from "./availabilityWatchModel";
import { WatchFetchConfirmDialog } from "./WatchFetchConfirmDialog";

/** What acting on a watched work needs: the target, the edition found, and where. */
export type WatchActionTarget = Pick<
  AvailabilityWatchTarget,
  "id" | "workCode" | "availableCode" | "availableSourceId"
>;

export type WatchBusyAction = "fetch" | "track" | "check" | "remove" | "cleanUp";

type Confirm =
  | { kind: "fetch"; targets: WatchActionTarget[] }
  | { kind: "remove"; targets: WatchActionTarget[] }
  | { kind: "cleanUp"; inLibrary: number; done: number; ids: number[] };

/**
 * Track, Fetch, Check now, Remove, and Clean up for watched works, by hand.
 * Fetch and removing several works confirm in a dialog; Track and Check now
 * queue at once. Each reports in a toast whose action opens the first run,
 * and `onChanged` receives the pool when the server returns it, or nothing
 * when the pool should be read again.
 */
export function useWatchTargetActions({
  onChanged,
  onOpenRun,
}: {
  onChanged: (watch?: AvailabilityWatch) => void;
  onOpenRun?: (runId: number) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<WatchBusyAction | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const runToast = (message: string, runId: number | undefined) =>
    toast.notify({
      kind: "info",
      message,
      ...(runId && onOpenRun
        ? { actionLabel: workflowCopy("watchView.viewRun"), onAction: () => onOpenRun(runId) }
        : {}),
    });

  const reportQueued = (action: "fetch" | "track", result: AvailabilityWatchActionResult) => {
    const count = result.queued.length;
    if (count === 0) {
      toast.warning(workflowCopy("watchView.nothingQueued"));
      return;
    }
    const key = action === "fetch" ? "watchView.fetchQueued" : "watchView.trackQueued";
    runToast(workflowCopy(key, { count, skipped: result.skipped }), result.runs[0]?.runId);
  };

  const act = async (action: "fetch" | "track", targets: readonly WatchActionTarget[], exclude: string[] = []) => {
    const ids = targets.slice(0, WATCH_ACTION_MAX_TARGETS).map((target) => target.id);
    if (ids.length === 0) return;
    setBusy(action);
    try {
      const result =
        action === "fetch"
          ? await api.fetchAvailabilityWatchTargets(ids, exclude)
          : await api.trackAvailabilityWatchTargets(ids);
      reportQueued(action, result);
      onChanged();
    } catch (error) {
      toast.notify(
        toastFromError(error, workflowCopy(action === "fetch" ? "watchView.fetchFailed" : "watchView.trackFailed")),
      );
    } finally {
      setBusy(null);
    }
  };

  const check = async (targetIds: number[] = []) => {
    setBusy("check");
    try {
      const result = await api.runAvailabilityWatch(targetIds);
      runToast(
        targetIds.length > 0
          ? workflowCopy("watchView.checkQueued", { count: result.targetCount })
          : workflowCopy("watchView.poolCheckQueued"),
        result.runId,
      );
      onChanged();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("availabilityWatchRunFailed")));
    } finally {
      setBusy(null);
    }
  };

  const removeNow = async (targets: readonly WatchActionTarget[]) => {
    setBusy("remove");
    try {
      const next = await api.removeAvailabilityWatchTargets(targets.map((target) => target.id));
      onChanged(next);
      toast.success(
        targets.length === 1
          ? workflowCopy("removedFromWatch", { workCode: targets[0].workCode })
          : workflowCopy("watchView.removed", { count: targets.length }),
      );
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("watchView.removeFailed")));
    } finally {
      setBusy(null);
    }
  };

  const cleanUpNow = async (ids: number[]) => {
    setBusy("cleanUp");
    try {
      const next = await api.cleanUpAvailabilityWatchTargets(ids);
      const remaining = new Set(next.targets.map((target) => target.id));
      onChanged(next);
      toast.success(workflowCopy("watchView.cleanedUp", { count: ids.filter((id) => !remaining.has(id)).length }));
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("watchView.cleanUpFailed")));
    } finally {
      setBusy(null);
    }
  };

  const close = () => setConfirm(null);
  let dialog: ReactNode = null;
  if (confirm?.kind === "fetch") {
    dialog = (
      <WatchFetchConfirmDialog
        targets={confirm.targets}
        onClose={close}
        onConfirm={(exclude) => {
          close();
          void act("fetch", confirm.targets, exclude);
        }}
      />
    );
  } else if (confirm?.kind === "remove") {
    const count = confirm.targets.length;
    dialog = (
      <Dialog onClose={close} size="sm" role="alertdialog">
        <DialogHeader
          icon={<Trash2 className="h-5 w-5" />}
          title={workflowCopy("watchView.removeConfirmTitle", { count })}
          description={workflowCopy("watchView.removeConfirmDescription")}
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            {workflowCopy("cancel")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              close();
              void removeNow(confirm.targets);
            }}
          >
            {workflowCopy("watchView.removeConfirm", { count })}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  } else if (confirm?.kind === "cleanUp") {
    dialog = (
      <Dialog onClose={close} size="sm" role="alertdialog">
        <DialogHeader
          icon={<ListX className="h-5 w-5" />}
          title={workflowCopy("watchView.cleanUpConfirmTitle", { count: confirm.ids.length })}
          description={workflowCopy("watchView.cleanUpConfirmDescription")}
        />
        <DialogBody>
          <ul className="space-y-1 text-sm">
            <li className="flex justify-between gap-3">
              <span>{workflowCopy("watchView.groups.inLibrary")}</span>
              <span className="tabular-nums">{confirm.inLibrary}</span>
            </li>
            <li className="flex justify-between gap-3">
              <span>{workflowCopy("watchView.cleanUpDone")}</span>
              <span className="tabular-nums">{confirm.done}</span>
            </li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            {workflowCopy("cancel")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              close();
              void cleanUpNow(confirm.ids);
            }}
          >
            {workflowCopy("watchView.cleanUpConfirm", { count: confirm.ids.length })}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return {
    busy,
    dialog,
    /** Opens the Fetch confirmation for the targets. */
    fetch: (targets: WatchActionTarget[]) => {
      if (targets.length > 0) setConfirm({ kind: "fetch", targets });
    },
    track: (targets: readonly WatchActionTarget[]) => void act("track", targets),
    /** Checks the listed targets, or the whole pool. */
    check: (targetIds?: number[]) => void check(targetIds),
    /** Removes one target at once, after its card's own second press. */
    removeOne: (target: WatchActionTarget) => void removeNow([target]),
    /** Confirms removing several targets in a dialog. */
    remove: (targets: WatchActionTarget[]) => {
      if (targets.length === 1) void removeNow(targets);
      else if (targets.length > 1) setConfirm({ kind: "remove", targets });
    },
    /** Confirms Clean up with both counts in a dialog. */
    cleanUp: (inLibrary: readonly WatchActionTarget[], done: readonly WatchActionTarget[]) => {
      const ids = [...inLibrary, ...done].map((target) => target.id);
      if (ids.length > 0) setConfirm({ kind: "cleanUp", inLibrary: inLibrary.length, done: done.length, ids });
    },
  };
}

export type WatchTargetActions = ReturnType<typeof useWatchTargetActions>;

import type { TFunction } from "i18next";
import { useState } from "react";

import {
  REMOTE_BULK_FETCH_PERMISSIONS,
  REMOTE_BULK_TRACK_PERMISSIONS,
  REMOTE_TRACK_PERMISSIONS,
  usePermissionGate,
} from "@/auth/usePermissionGate";
import { toastFromError, type useToast } from "@/components/ui/toast";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { api, type LibrarySource, type ListeningStatus, type RemoteWork } from "@/lib/api";
import { libraryBulkCopy, useRemoteWorkActions } from "@/pages/useRemoteWorkActions";

import { remoteWorkActionCode } from "./remoteSourceBrowseModel";

export function useRemoteSourceActions({
  source,
  selectedSyncable,
  selectedSaveable,
  toast,
  t,
  onWorkStateChanged,
  onSynced,
}: {
  source: LibrarySource;
  selectedSyncable: RemoteWork[];
  selectedSaveable: RemoteWork[];
  toast: ReturnType<typeof useToast>;
  t: TFunction;
  onWorkStateChanged: (
    primaryCode: string,
    patch: Partial<Pick<RemoteWork, "workId" | "favorite" | "listeningStatus">>,
  ) => void;
  onSynced: (workID: number, options?: { openTracked?: boolean }) => Promise<void>;
}) {
  const requireBulkFetch = usePermissionGate(REMOTE_BULK_FETCH_PERMISSIONS);
  const requireBulkTrack = usePermissionGate(REMOTE_BULK_TRACK_PERMISSIONS, { deferDemo: true });
  const requireTrack = usePermissionGate(REMOTE_TRACK_PERMISSIONS, { deferDemo: true });
  const [isSyncingCode, setIsSyncingCode] = useState<string | null>(null);
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ codes: string[]; run: () => Promise<void> } | null>(null);
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged: () => onSynced(0) });
  const remoteWorkActions = useRemoteWorkActions();
  const remoteTargets = (works: readonly RemoteWork[]) =>
    works.map((work) => ({ sourceId: source.id, code: remoteWorkActionCode(work) }));

  const forkWork = async (work: RemoteWork, reason: string) => {
    if (!work.primaryCode) {
      toast.warning(t("library.remoteWorkNoCode"));
      return;
    }
    if (!requireTrack()) return;
    setIsSyncingCode(work.primaryCode);
    try {
      await remoteWorkActions.queueFork({ sourceId: source.id, code: remoteWorkActionCode(work) }, reason);
    } finally {
      setIsSyncingCode(null);
    }
  };

  const runBulkSaveSelected = async () => {
    if (!requireBulkFetch()) return;
    setIsBulkBusy(true);
    try {
      await remoteWorkActions.recordBulkRuns("fetch", remoteTargets(selectedSaveable), libraryBulkCopy, () =>
        onSynced(0),
      );
    } finally {
      setIsBulkBusy(false);
      setSaveConfirm(null);
    }
  };

  const bulkForkSelected = async () => {
    if (selectedSyncable.length === 0 || !requireBulkTrack()) return;
    setIsBulkBusy(true);
    try {
      await remoteWorkActions.recordBulkRuns("track", remoteTargets(selectedSyncable), libraryBulkCopy, () =>
        onSynced(0),
      );
    } finally {
      setIsBulkBusy(false);
    }
  };

  const bulkSaveSelected = async () => {
    if (selectedSaveable.length === 0 || !requireBulkFetch()) return;
    setSaveConfirm({ codes: selectedSaveable.map((work) => work.primaryCode), run: runBulkSaveSelected });
  };

  const ensureRemoteWorkForState = async (work: RemoteWork, reason: string) => {
    const result = await api.syncRemoteSourceWork(source.id, remoteWorkActionCode(work), reason);
    onWorkStateChanged(work.primaryCode, { workId: result.workId });
    await onSynced(result.workId);
    return result.workId;
  };

  /** A mark or list on a work not yet in the Library adds it there first, which is tracking. */
  const canStateRemoteWork = (work: RemoteWork) => Boolean(work.workId) || requireTrack();

  const markRemoteWork = async (work: RemoteWork, status: ListeningStatus) => {
    if (!work.primaryCode || !canStateRemoteWork(work)) return;
    setIsSyncingCode(work.primaryCode);
    try {
      const workId = work.workId ?? (await ensureRemoteWorkForState(work, "mark_interest"));
      if (!workId) return;
      await api.updateWorkUserState(workId, { listeningStatus: status });
      onWorkStateChanged(work.primaryCode, { workId, listeningStatus: status });
      toast.success(t("library.savedAndMarked", { code: work.primaryCode }));
      await onSynced(workId);
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setIsSyncingCode(null);
    }
  };

  const ensureRemoteWorkForList = async (work: RemoteWork) => {
    if (work.workId) return work.workId;
    if (!work.primaryCode || !canStateRemoteWork(work)) return null;
    setIsSyncingCode(work.primaryCode);
    try {
      const result = await api.syncRemoteSourceWork(source.id, remoteWorkActionCode(work), "list_remote");
      toast.success(t("library.savedForList", { code: result.primaryCode }));
      return result.workId;
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
      return null;
    } finally {
      setIsSyncingCode(null);
    }
  };

  return {
    fetchWorkspace,
    isSyncingCode,
    isBulkBusy,
    saveConfirm,
    clearSaveConfirm: () => setSaveConfirm(null),
    forkWork,
    bulkForkSelected,
    bulkSaveSelected,
    runBulkSaveSelected,
    markRemoteWork,
    canStateRemoteWork,
    ensureRemoteWorkForList,
  };
}

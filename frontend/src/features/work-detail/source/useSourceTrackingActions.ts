import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, type SourcePresenceItem, type WorkDetail } from "@/lib/api";
import { useAuth } from "@/auth/AuthProvider";
import { REMOTE_TRACK_PERMISSIONS, usePermissionGate } from "@/auth/usePermissionGate";
import {
  announceRemoteTrackCreated,
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/lib/remoteTrackWorkflows";
import { toastFromError, useToast } from "@/components/ui/toast";
import { persistedTrackingActionState } from "@/features/work-detail/persistedWorkDetailModel";
import {
  type ReforkTarget,
  remoteAvailabilityRouteCode,
  type RemoteSourceAvailability,
  remoteSourceTabKey,
} from "@/features/work-detail/source/sourceContextModel";
import type { useWorkSourceContext } from "@/features/work-detail/source/useWorkSourceContext";
import { remoteDetailActionCode, trackedPresenceForRemoteSource } from "@/features/work-detail/workDetailHelpers";

async function resolveTrackedPresence({
  activePresence,
  selectedRemoteSource,
  selectedRemoteWorkCode,
  work,
}: {
  activePresence: SourcePresenceItem | null;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteWorkCode: string;
  work: WorkDetail;
}) {
  if (activePresence || !selectedRemoteSource?.summary.hasTracked) return activePresence;
  const currentWork = await api.getWork(work.id);
  return trackedPresenceForRemoteSource(currentWork, selectedRemoteSource.source.id, selectedRemoteWorkCode);
}

/**
 * Track, Fork, untrack, and the on-demand source check for a persisted work.
 * Each changes shared Library state or asks every remote source, so all of
 * them need remote:track. A finished Track run reloads the detail it changed.
 */
export function useSourceTrackingActions({
  work,
  sourceContext,
  onWorkReload,
  onWorksChanged,
  onUntrackStart,
}: {
  work: WorkDetail | null;
  sourceContext: ReturnType<typeof useWorkSourceContext>;
  onWorkReload: (workID: number, includeMedia?: boolean) => Promise<void>;
  onWorksChanged: () => Promise<void>;
  onUntrackStart: () => void;
}) {
  const auth = useAuth();
  const requireTrack = usePermissionGate(REMOTE_TRACK_PERMISSIONS, { deferDemo: true });
  const canCheckSources = !auth.demoMode && auth.hasPermission("remote:track");
  const toast = useToast();
  const { t } = useTranslation();
  const {
    remoteSources,
    setActiveSourceKey,
    selectedRemoteSource,
    selectedTrackedPresence,
    selectedTrackedForked,
    selectedTrackedRemoteSource,
    selectedRemoteWorkCode,
    refreshAvailability,
  } = sourceContext;
  const [isBusy, setIsBusy] = useState(false);
  const [reforkTarget, setReforkTarget] = useState<ReforkTarget | null>(null);
  const currentForkSource = selectedTrackedRemoteSource ?? selectedRemoteSource ?? null;
  const { activeTrackedPresence, selectedRemoteHasTracked, hasTrackedSource, canTrackRemote } =
    persistedTrackingActionState({ work, selectedRemoteSource, selectedRemoteWorkCode, selectedTrackedPresence });

  useEffect(() => {
    const reconcileTrack = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (
        !terminal ||
        (terminal.status !== "succeeded" && terminal.status !== "partial") ||
        !terminal.workId ||
        !work ||
        !remoteSources.some((remote) =>
          isMatchingRemoteTrack(
            terminal,
            remote.source.id,
            remote.summary.primaryCode,
            remote.detail?.primaryCode,
            remote.detail?.remoteCode,
            work.primaryCode,
          ),
        )
      )
        return;
      void Promise.all([onWorkReload(terminal.workId, true), onWorksChanged(), refreshAvailability()]).catch(
        (error) => {
          toast.notify(toastFromError(error, t("libraryDetail.trackCompletedReloadFailed")));
        },
      );
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
  }, [onWorkReload, onWorksChanged, refreshAvailability, remoteSources, t, toast, work]);

  const track = async () => {
    if (!selectedRemoteSource?.detail?.primaryCode || !requireTrack()) return;
    setIsBusy(true);
    try {
      const requestedCode = remoteDetailActionCode(selectedRemoteSource.detail);
      const result = await api.trackRemoteSourceWork(selectedRemoteSource.source.id, requestedCode, "manual_track");
      announceRemoteTrackCreated(selectedRemoteSource.source.id, requestedCode, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? t("libraryDetail.trackAlreadyQueued", { runId: result.runId })
          : t("libraryDetail.trackQueued", { runId: result.runId }),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.trackQueueFailed")));
    } finally {
      setIsBusy(false);
    }
  };

  const untrack = async () => {
    if (!work || !requireTrack()) return;
    onUntrackStart();
    setIsBusy(true);
    try {
      const presence = await resolveTrackedPresence({
        activePresence: activeTrackedPresence,
        selectedRemoteSource,
        selectedRemoteWorkCode,
        work,
      });
      if (!presence?.fileSourceId) throw new Error("Tracked source could not be resolved.");
      const sourceID = presence.fileSourceId;
      const ownerWorkID = presence.workId || work.id;
      const sourceName = presence.fileSourceName || presence.fileSourceCode || t("libraryDetail.sourceInfo");
      await api.untrackWorkSource(ownerWorkID, sourceID);
      toast.success(t("libraryDetail.untrackedFromSource", { code: work.primaryCode, source: sourceName }));
      const remoteToKeep = selectedRemoteSource ?? selectedTrackedRemoteSource;
      if (remoteToKeep) setActiveSourceKey(remoteSourceTabKey(remoteToKeep.source.id));
      await onWorkReload(work.id, true);
      await onWorksChanged();
      try {
        await refreshAvailability();
      } catch {
        // The work detail reload is authoritative; availability can be checked again from Source.
      }
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setIsBusy(false);
    }
  };

  const fork = async (remote: RemoteSourceAvailability) => {
    if (!work?.primaryCode) return;
    setIsBusy(true);
    try {
      const requestedCode = remoteAvailabilityRouteCode(remote.summary, work.primaryCode);
      const result = await api.trackRemoteSourceWork(remote.source.id, requestedCode, "manual_fork");
      announceRemoteTrackCreated(remote.source.id, requestedCode, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? t("libraryDetail.forkAlreadyQueued", { runId: result.runId })
          : t("libraryDetail.forkQueued", { runId: result.runId }),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.forkQueueFailed")));
    } finally {
      setIsBusy(false);
    }
  };

  /** Forks directly, or asks first when the work already has a fork to replace. */
  const requestFork = (remote: RemoteSourceAvailability) => {
    if (!requireTrack()) return;
    if (selectedTrackedForked || selectedRemoteSource?.summary.hasRemote) {
      setReforkTarget({ current: currentForkSource, next: remote });
      return;
    }
    void fork(remote);
  };

  const confirmRefork = (remote: RemoteSourceAvailability) => {
    setReforkTarget(null);
    void fork(remote);
  };

  const checkSources = async () => {
    if (!work?.primaryCode) return;
    // Checking sources probes remotes and persists availability, so Demo answers locally instead.
    if (auth.demoMode) {
      toast.warning(t("permissions.demoReadOnly"));
      return;
    }
    if (!requireTrack()) return;
    try {
      const result = await refreshAvailability();
      if (!result) return;
      toast.success(t("libraryDetail.sourceAvailabilityUpdated"));
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.sourceCheckFailed")));
    }
  };

  return {
    isBusy,
    /** Checked at the first untrack click. */
    requireTrack,
    canCheckSources,
    currentForkSource,
    selectedRemoteHasTracked,
    hasTrackedSource,
    canTrackRemote,
    reforkTarget,
    track,
    untrack,
    requestFork,
    confirmRefork,
    cancelRefork: () => setReforkTarget(null),
    checkSources,
  };
}

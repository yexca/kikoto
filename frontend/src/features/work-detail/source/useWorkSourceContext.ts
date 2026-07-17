import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  type LibrarySource,
  type SourceAvailabilityResponse,
  type WorkDetail,
} from "@/lib/api";
import {
  buildSourceTabs,
  buildTrackedPresenceOptions,
  remoteAvailabilityRouteCode,
  remoteSourceCanBrowse,
  remoteSourceForTrackedPresence,
  remoteSourceTabKey,
  trackedPresenceForked,
  trackedPresenceSourceID,
  type DetailSourceIntent,
  type RemoteSourceAvailability,
} from "@/features/work-detail/source/sourceContextModel";

export function useWorkSourceContext({
  code,
  work,
  sources,
  initialSourceIntent,
  initialTrackedSourceID,
  initialRemoteCode,
}: {
  code: string;
  work: WorkDetail | null;
  sources: LibrarySource[];
  initialSourceIntent: DetailSourceIntent;
  initialTrackedSourceID: number | null;
  initialRemoteCode: string;
}) {
  const [remoteSources, setRemoteSources] = useState<RemoteSourceAvailability[]>([]);
  const [isCheckingSources, setIsCheckingSources] = useState(false);
  const [sourceCheckedAt, setSourceCheckedAt] = useState("");
  const [activeSourceKey, setActiveSourceKey] = useState<string>(initialSourceIntent);
  const [selectedTrackedPresenceKey, setSelectedTrackedPresenceKey] = useState("");
  const [remoteLoadVersion, setRemoteLoadVersion] = useState(0);
  const trackedPresenceOptions = useMemo(
    () => buildTrackedPresenceOptions(work?.mediaItems ?? [], remoteSources, work?.sourcePresence ?? []),
    [remoteSources, work?.mediaItems, work?.sourcePresence],
  );
  const selectedTrackedOption = useMemo(
    () => trackedPresenceOptions.find((option) => option.key === selectedTrackedPresenceKey)
      ?? trackedPresenceOptions.find((option) => option.presence.fileSourceId === initialTrackedSourceID)
      ?? trackedPresenceOptions.find((option) => option.forked)
      ?? trackedPresenceOptions[0],
    [initialTrackedSourceID, selectedTrackedPresenceKey, trackedPresenceOptions],
  );
  const sourceTabs = useMemo(
    () => buildSourceTabs(work?.mediaItems ?? [], remoteSources, work?.sourcePresence ?? [], selectedTrackedOption),
    [remoteSources, selectedTrackedOption, work?.mediaItems, work?.sourcePresence],
  );
  const selectedSource = sourceTabs.find((source) => source.key === activeSourceKey)
    ?? sourceTabs.find((source) => source.kind === activeSourceKey)
    ?? sourceTabs[0];
  const resolvedActiveSourceKey = selectedSource?.key ?? activeSourceKey;
  const selectedRemoteSource = selectedSource?.kind === "remote"
    ? remoteSources.find((item) => selectedSource.key === remoteSourceTabKey(item.source.id))
    : undefined;
  const selectedTrackedPresence = selectedSource?.kind === "tracked" ? selectedTrackedOption?.presence ?? null : null;
  const selectedTrackedForked = trackedPresenceForked(selectedTrackedPresence, work?.mediaItems ?? []);
  const selectedTrackedSourceID = trackedPresenceSourceID(selectedTrackedPresence);
  const selectedTrackedRemoteSource = remoteSourceForTrackedPresence(selectedTrackedPresence, remoteSources);
  const selectedRemoteDetail = selectedRemoteSource?.detail ?? null;
  const selectedRemoteSourceID = selectedRemoteSource?.source.id ?? null;
  const selectedRemoteWorkCode = selectedRemoteSource
    ? remoteSourceTabKey(selectedRemoteSource.source.id) === initialSourceIntent && initialRemoteCode
      ? initialRemoteCode
      : remoteAvailabilityRouteCode(selectedRemoteSource.summary, work?.primaryCode || code)
    : work?.primaryCode || code;

  const applyAvailability = useCallback((result: SourceAvailabilityResponse) => {
    const knownSources = result.sources.flatMap((summary) => {
      const source = sources.find((candidate) => candidate.id === summary.sourceId);
      return source ? [{ source, summary }] : [];
    });
    setRemoteSources((current) => knownSources.map((next) => {
      const previous = current.find((item) => item.source.id === next.source.id);
      return previous?.detail ? { ...next, detail: previous.detail } : next;
    }));
    setSourceCheckedAt(result.checkedAt);
    setRemoteLoadVersion((version) => version + 1);
  }, [sources]);

  const refreshAvailability = useCallback(async () => {
    if (!work?.primaryCode) return null;
    setIsCheckingSources(true);
    try {
      const result = await api.checkSourceAvailability(work.primaryCode);
      applyAvailability(result);
      return result;
    } finally {
      setIsCheckingSources(false);
    }
  }, [applyAvailability, work?.primaryCode]);

  const selectSource = useCallback((key: string) => {
    setActiveSourceKey(key);
    if (!key.startsWith("remote-source:")) return;
    setRemoteSources((items) =>
      items.map((item) => (remoteSourceTabKey(item.source.id) === key && item.error ? { ...item, error: "" } : item)),
    );
    setRemoteLoadVersion((version) => version + 1);
  }, []);

  const selectTrackedPresence = useCallback((key: string) => {
    setSelectedTrackedPresenceKey(key);
    setActiveSourceKey("tracked");
  }, []);

  useEffect(() => {
    if (!work || sourceTabs.length === 0 || sourceTabs.some((source) => source.key === activeSourceKey)) return;
    if (activeSourceKey.startsWith("remote-source:") && !sourceCheckedAt) return;
    const intendedSource = sourceTabs.find((source) => source.kind === activeSourceKey);
    setActiveSourceKey(intendedSource?.key ?? sourceTabs[0].key);
  }, [activeSourceKey, sourceCheckedAt, sourceTabs, work]);

  useEffect(() => {
    setRemoteSources([]);
    setSourceCheckedAt("");
    if (!work?.primaryCode || sources.length === 0) return;
    let cancelled = false;
    api.getSourceAvailability(work.primaryCode)
      .then((result) => {
        if (!cancelled) applyAvailability(result);
      })
      .catch(() => {
        if (!cancelled) setRemoteSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [applyAvailability, sources.length, work?.primaryCode]);

  useEffect(() => {
    if (!selectedRemoteSource || !remoteSourceCanBrowse(selectedRemoteSource.summary) || selectedRemoteSource.detail || selectedRemoteSource.loading || selectedRemoteSource.error) return;
    const controller = new AbortController();
    const sourceID = selectedRemoteSource.source.id;
    setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, loading: true, error: "" } : item));
    api.getRemoteSourceWork(sourceID, selectedRemoteWorkCode, controller.signal)
      .then((detail) => {
        setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, detail, loading: false, error: "" } : item));
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRemoteSources((items) => items.map((item) => item.source.id === sourceID
          ? { ...item, loading: false, error: error instanceof Error ? error.message : "Remote detail failed." }
          : item));
      });
    return () => controller.abort();
  }, [remoteLoadVersion, selectedRemoteSourceID, selectedRemoteWorkCode]);

  useEffect(() => {
    setActiveSourceKey(initialSourceIntent);
    setSelectedTrackedPresenceKey("");
  }, [initialRemoteCode, initialSourceIntent, initialTrackedSourceID, work?.id]);

  return {
    remoteSources,
    sourceTabs,
    activeSourceKey,
    setActiveSourceKey,
    selectSource,
    selectTrackedPresence,
    trackedPresenceOptions,
    selectedTrackedPresenceKey: selectedTrackedOption?.key ?? "",
    selectedSource,
    resolvedActiveSourceKey,
    selectedRemoteSource,
    selectedTrackedPresence,
    selectedTrackedForked,
    selectedTrackedSourceID,
    selectedTrackedRemoteSource,
    selectedRemoteDetail,
    selectedRemoteSourceID,
    selectedRemoteWorkCode,
    isCheckingSources,
    sourceCheckedAt,
    refreshAvailability,
  };
}

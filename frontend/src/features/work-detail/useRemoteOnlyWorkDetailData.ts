import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
import { toastFromError, useToast } from "@/components/ui/toast";
import { loadRemoteOnlyDetail } from "@/features/work-detail/remoteOnlyWorkDetailModel";
import type { RemoteSourceAvailability } from "@/features/work-detail/source/sourceContextModel";
import type { RemoteWorkPreview } from "@/features/work-detail/workDetailShared";
import {
  api,
  type LibrarySource,
  type RemoteWorkDetail,
  type SourceAvailabilityResponse,
  type WorkDetail,
} from "@/lib/api";

function initialRemoteAvailability(
  sources: LibrarySource[],
  code: string,
  preview: RemoteWorkPreview | null,
): RemoteSourceAvailability[] {
  return sources
    .filter((candidate) => candidate.sourceType.startsWith("kikoeru"))
    .map((candidate) => ({
      source: candidate,
      summary: {
        sourceId: candidate.id,
        sourceCode: candidate.code,
        displayName: candidate.displayName,
        status: "unknown" as const,
        remoteId: "",
        primaryCode: code,
        title: preview?.title ?? "",
        coverUrl: preview?.coverUrl ?? "",
        workId: null,
        hasRemote: false,
        hasTracked: false,
        hasCache: false,
        hasLocal: false,
        error: "",
        elapsedMs: 0,
      },
    }));
}

/**
 * What a remote-only work detail shows: the remote source's metadata and
 * tracks, every remote source's availability for the code, and the Library
 * work a track has materialized. A finished track of this work reloads the
 * materialized work and availability. `onReset` runs when the source or code
 * changes.
 */
export function useRemoteOnlyWorkDetailData({
  source,
  sources,
  code,
  preview,
  onWorksChanged,
  onReset,
}: {
  source: LibrarySource;
  sources: LibrarySource[];
  code: string;
  preview: RemoteWorkPreview | null;
  onWorksChanged: () => Promise<void>;
  /** A stable callback. */
  onReset: () => void;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const [detail, setDetail] = useState<RemoteWorkDetail | null>(null);
  const [identityDetail, setIdentityDetail] = useState<RemoteWorkDetail | null>(null);
  const [selectedMetadataVariantKey, setSelectedMetadataVariantKey] = useState("");
  const [trackedWork, setTrackedWork] = useState<WorkDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [message, setMessage] = useState("");
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState("");
  const [remoteRetryToken, setRemoteRetryToken] = useState(0);
  const [remoteAvailability, setRemoteAvailability] = useState<RemoteSourceAvailability[]>(() =>
    initialRemoteAvailability(sources, code, preview),
  );
  const [availabilityLoading, setAvailabilityLoading] = useState(true);

  /** Takes each source's summary from an availability result. */
  const applyAvailability = (result: SourceAvailabilityResponse) =>
    setRemoteAvailability((current) =>
      current.map((item) => {
        const summary = result.sources.find((candidate) => candidate.sourceId === item.source.id);
        return summary ? { ...item, summary } : item;
      }),
    );

  useEffect(() => {
    let cancelled = false;
    setAvailabilityLoading(true);
    api
      .getSourceAvailability(code)
      .then(async (result) => {
        if (cancelled) return;
        setRemoteAvailability((current) =>
          current.map((item) => {
            const summary = result.sources.find((candidate) => candidate.sourceId === item.source.id);
            return summary ? { ...item, summary } : item;
          }),
        );
        const summary = result.sources.find((candidate) => candidate.sourceId === source.id);
        if (!summary?.workId) {
          setTrackedWork(null);
          return;
        }
        try {
          const nextWork = await api.getWork(summary.workId);
          if (!cancelled) setTrackedWork(nextWork);
        } catch {
          // Availability still controls Track state when materialized detail cannot be loaded.
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAvailabilityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, remoteRetryToken, source.id]);

  useEffect(() => {
    setDetail(null);
    setIdentityDetail(null);
    setSelectedMetadataVariantKey("");
    setTrackedWork(null);
    setNotFound(false);
    setMessage("");
    setTreeLoading(false);
    setTreeError("");
    onReset();
  }, [onReset, source.id, code]);

  useEffect(() => {
    setNotFound(false);
    setMessage("");
    setTreeError("");
    setTreeLoading(true);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    void loadRemoteOnlyDetail({
      sourceID: source.id,
      code,
      signal: controller.signal,
      didTimeOut: () => timedOut,
      onMetadata: (next) => {
        setDetail((current) => ({ ...next, tracks: current?.tracks ?? [] }));
        setIdentityDetail(next);
        setRemoteAvailability((items) =>
          items.map((item) =>
            item.source.id === source.id
              ? {
                  ...item,
                  summary: {
                    ...item.summary,
                    status: "available",
                    remoteId: next.remoteId,
                    primaryCode: next.primaryCode,
                    title: next.title,
                    coverUrl: next.coverUrl,
                    workId: next.workId,
                    hasRemote: true,
                  },
                }
              : item,
          ),
        );
      },
      onTracks: (tracks) => {
        setDetail((current) => (current ? { ...current, tracks } : current));
        setTreeError("");
      },
      onTreeError: setTreeError,
    })
      .then((outcome) => {
        if (outcome.kind === "not_found") {
          setNotFound(true);
          return;
        }
        if (outcome.kind === "failed") {
          setMessage(outcome.message);
          toast.notify({ kind: "error", message: outcome.message });
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!controller.signal.aborted || timedOut) setTreeLoading(false);
      });
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [source.id, code, remoteRetryToken, toast]);

  useEffect(() => {
    const reconcileTrack = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (
        !terminal ||
        (terminal.status !== "succeeded" && terminal.status !== "partial") ||
        !terminal.workId ||
        !isMatchingRemoteTrack(terminal, source.id, code, detail?.primaryCode, detail?.remoteCode)
      )
        return;
      void (async () => {
        const [nextWork, availability] = await Promise.all([
          api.getWork(terminal.workId as number),
          api.getSourceAvailability(terminal.primaryCode || detail?.primaryCode || code).catch(() => null),
          onWorksChanged(),
        ]);
        setTrackedWork(nextWork);
        setDetail((current) => (current ? { ...current, workId: terminal.workId, importStatus: "synced" } : current));
        setIdentityDetail((current) =>
          current ? { ...current, workId: terminal.workId, importStatus: "synced" } : current,
        );
        if (availability) {
          setRemoteAvailability((current) =>
            current.map((item) => {
              const summary = availability.sources.find((candidate) => candidate.sourceId === item.source.id);
              return summary ? { ...item, summary } : item;
            }),
          );
        }
      })().catch((error) => {
        toast.notify(toastFromError(error, t("libraryDetail.trackCompletedReloadFailed")));
      });
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
  }, [code, detail?.primaryCode, detail?.remoteCode, onWorksChanged, source.id, t, toast]);

  return {
    detail,
    setDetail,
    identityDetail,
    selectedMetadataVariantKey,
    setSelectedMetadataVariantKey,
    trackedWork,
    setTrackedWork,
    notFound,
    message,
    setMessage,
    treeLoading,
    setTreeLoading,
    treeError,
    setTreeError,
    remoteAvailability,
    applyAvailability,
    availabilityLoading,
    retry: () => setRemoteRetryToken((value) => value + 1),
  };
}

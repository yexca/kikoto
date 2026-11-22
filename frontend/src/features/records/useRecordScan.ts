import { useCallback, useEffect, useRef, useState } from "react";

import { api, type RecordActivity } from "@/lib/api";

import {
  isActiveRecordRun as isActive,
  recordScanState,
  type RecordScanRequest,
  type RecordScanState,
} from "./recordScanModel";
import type { RecordRootReading } from "./useRecordLibrary";

export type { RecordScanState };

const scanPollMs = 2_500;
const probePollMs = 5_000;

/**
 * Queues a record scan and follows the record workflows through the root
 * reading: the scan run until it ends, then the run that reads media details
 * after it. While either is queued or running the root is read again, and the
 * folder is listed again when a scan or a media details run ends. A scan or a
 * run started elsewhere, or before the page opened, is followed the same way.
 */
export function useRecordScan({
  activity,
  reloadRoot,
  onFinished,
}: {
  activity: RecordActivity | null;
  reloadRoot: () => Promise<RecordRootReading | null>;
  onFinished: () => void;
}) {
  const [request, setRequest] = useState<RecordScanRequest>({ status: "idle" });
  const [tick, setTick] = useState(0);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  });

  const scan = activity?.scan;
  const following = request.status === "following";
  // A followed scan has ended once the root reports its run, or a later one, as ended.
  const followedEnded = following && scan !== undefined && scan.runId >= request.runId && !isActive(scan);
  const scanActive = isActive(scan) || (following && !followedEnded);
  const probeActive = isActive(activity?.probe);

  // Lists the folder again once for each scan that ends, and once for each
  // media details run that ends, so new files and their lengths appear.
  const seen = useRef<{ scanRunId: number | null; endedScanRunId: number | null; probeRunId: number | null }>({
    scanRunId: null,
    endedScanRunId: null,
    probeRunId: null,
  });
  useEffect(() => {
    const watched = seen.current;
    if (
      scan &&
      scan.runId !== watched.endedScanRunId &&
      (isActive(scan) || (following && request.runId === scan.runId))
    ) {
      watched.scanRunId = scan.runId;
    }
    if (scan && watched.scanRunId === scan.runId && !isActive(scan)) {
      watched.scanRunId = null;
      watched.endedScanRunId = scan.runId;
      onFinishedRef.current();
    }
    const probe = activity?.probe;
    if (probe && isActive(probe)) {
      watched.probeRunId = probe.runId;
    } else if (watched.probeRunId !== null) {
      watched.probeRunId = null;
      onFinishedRef.current();
    }
  }, [activity, following, request, scan]);

  const polling = scanActive || probeActive;
  useEffect(() => {
    if (!polling) return;
    const timer = window.setTimeout(
      () => {
        void reloadRoot().finally(() => setTick((value) => value + 1));
      },
      scanActive ? scanPollMs : probePollMs,
    );
    return () => window.clearTimeout(timer);
  }, [polling, scanActive, tick, reloadRoot]);

  const state = recordScanState(request, activity);

  const start = useCallback(async () => {
    setRequest({ status: "queueing" });
    try {
      const queued = await api.queueRecordScan();
      setRequest({ status: "following", runId: queued.runId });
    } catch {
      setRequest({ status: "rejected" });
      return;
    }
    void reloadRoot();
  }, [reloadRoot]);

  return { state, start };
}

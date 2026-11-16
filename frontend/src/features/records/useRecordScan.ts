import { useCallback, useEffect, useRef, useState } from "react";

import { api, type RecordRoot } from "@/lib/api";

/** Inline scan state beside the toolbar's Scan action. */
export type RecordScanState =
  | { status: "idle" }
  | { status: "queueing" }
  | { status: "queued" }
  | { status: "running" }
  | { status: "finished" }
  | { status: "failed" }
  /** The scan outlasted the page's polling; it keeps running as a workflow. */
  | { status: "unconfirmed" };

const pollIntervalMs = 2_500;
const maxPolls = 72;

/**
 * Queues a record scan and follows it through the root state: a higher scan
 * generation means the walk started, and a new last-scanned time means it
 * finished. Polling stops after a bounded time and when the page unmounts.
 */
export function useRecordScan({
  reloadRoot,
  onFinished,
}: {
  reloadRoot: () => Promise<RecordRoot | null>;
  onFinished: () => void;
}) {
  const [state, setState] = useState<RecordScanState>({ status: "idle" });
  const timer = useRef<number | null>(null);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  });

  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback(
    async (before: RecordRoot) => {
      stop();
      setState({ status: "queueing" });
      try {
        await api.queueRecordScan();
      } catch {
        setState({ status: "failed" });
        return;
      }
      setState({ status: "queued" });
      let polls = 0;
      const poll = async () => {
        polls += 1;
        const root = await reloadRoot();
        if (root && root.lastScannedAt && root.lastScannedAt !== before.lastScannedAt) {
          timer.current = null;
          setState({ status: "finished" });
          onFinishedRef.current();
          return;
        }
        if (root && root.scanGeneration > before.scanGeneration) setState({ status: "running" });
        if (polls >= maxPolls) {
          timer.current = null;
          setState({ status: "unconfirmed" });
          return;
        }
        timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
      };
      timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
    },
    [reloadRoot, stop],
  );

  return { state, start };
}

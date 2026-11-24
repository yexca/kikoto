import { useCallback, useEffect, useState } from "react";

import { useStableCallback } from "@/hooks/useStableCallback";
import { startLoad, type Load } from "@/lib/effectScope";

type DebouncedRequestState<T> = { result: T | null; resultKey: string | null; failed: boolean };

/**
 * Sends the request that `key` names once the key has held still for
 * `delayMs`, and keeps the last result while a newer request waits, such as
 * the preview of an edit the viewer is still changing.
 *
 * Only `key`, `enabled`, and a retry send again. `send` is read when the wait
 * ends, so it can be rebuilt on every render; `key` must name everything it
 * sends, usually the serialized request and its target. A new key, `enabled`
 * turning off, or unmounting cancels the wait and aborts a request in flight.
 */
export function useDebouncedRequest<T>({
  key,
  enabled = true,
  delayMs,
  send,
  onResult,
}: {
  key: string;
  enabled?: boolean;
  delayMs: number;
  send: Load<T>;
  /** Receives each result as it arrives, for state that has to be set alongside it. */
  onResult?: (result: T) => void;
}) {
  const [state, setState] = useState<DebouncedRequestState<T>>({ result: null, resultKey: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  const sendLatest = useStableCallback(send);
  const receive = useStableCallback((result: T) => onResult?.(result));

  useEffect(() => {
    if (!enabled) return;
    return startLoad(
      sendLatest,
      {
        onSuccess: (result) => {
          setState({ result, resultKey: key, failed: false });
          receive(result);
        },
        onError: () => setState((current) => ({ ...current, failed: true })),
      },
      { delayMs },
    );
  }, [attempt, delayMs, enabled, key, receive, sendLatest]);

  /** Sends the current request again after the delay, clearing the failure. */
  const retry = useCallback(() => {
    setState((current) => ({ ...current, failed: false }));
    setAttempt((value) => value + 1);
  }, []);
  /** Keeps the last result for display but no longer counts it as current, and sends again. */
  const invalidate = useCallback(() => {
    setState((current) => ({ ...current, resultKey: null }));
    setAttempt((value) => value + 1);
  }, []);
  /** Forgets the last result. */
  const clear = useCallback(() => setState((current) => ({ ...current, result: null, resultKey: null })), []);

  return {
    /** The last result that arrived, which may answer an older key. */
    result: state.result,
    /** Whether `result` answers the current key. */
    current: state.resultKey !== null && state.resultKey === key,
    /** Whether the latest request failed; it stays set until one succeeds or `retry`. */
    failed: state.failed,
    retry,
    invalidate,
    clear,
  };
}

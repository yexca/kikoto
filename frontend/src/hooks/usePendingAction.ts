import { useCallback, useRef, useState } from "react";

/**
 * Runs one async action at a time for a group of related controls. `pending`
 * names the running action so its control can show progress while the group
 * is disabled, and a request made while another runs is ignored. A failure is
 * passed to `onError` and resolves to false, so the caller keeps its current
 * UI, such as an open confirmation, for another attempt.
 */
export function usePendingAction<Key extends string>() {
  const [pending, setPending] = useState<Key | null>(null);
  const running = useRef(false);
  const run = useCallback(
    async (key: Key, action: () => Promise<unknown>, onError: (error: unknown) => void): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      setPending(key);
      try {
        await action();
        return true;
      } catch (error) {
        onError(error);
        return false;
      } finally {
        running.current = false;
        setPending(null);
      }
    },
    [],
  );
  return { pending, run };
}

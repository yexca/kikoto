import { useCallback, useEffect, useState } from "react";

import { isActiveRunStatus } from "@/features/workflows/runPresentation";
import { api, type FileSourcePresenceCheck } from "@/lib/api";
import { createEffectScope } from "@/lib/effectScope";

const busyPollMs = 4000;

/**
 * Each checkable remote source's latest library work check and next scheduled
 * one, read again every few seconds while a check is queued or running.
 */
export function useSourcePresenceChecks(enabled: boolean) {
  const [checks, setChecks] = useState<Record<number, FileSourcePresenceCheck>>({});
  const [revision, setRevision] = useState(0);
  const busy = Object.values(checks).some((check) => check.lastRun && isActiveRunStatus(check.lastRun.status));

  useEffect(() => {
    if (!enabled) return;
    const scope = createEffectScope();
    const load = () =>
      scope.load(() => api.listFileSources(), {
        onSuccess: (sources) =>
          setChecks(
            Object.fromEntries(
              sources.flatMap((source) => (source.presenceCheck ? [[source.id, source.presenceCheck] as const] : [])),
            ),
          ),
      });
    load();
    const timer = busy ? window.setInterval(load, busyPollMs) : null;
    return () => {
      scope.cancel();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [busy, enabled, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { checks, refresh };
}

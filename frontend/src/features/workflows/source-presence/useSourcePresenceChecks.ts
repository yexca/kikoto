import { useCallback, useEffect, useState } from "react";

import { isActiveRunStatus } from "@/features/workflows/runPresentation";
import { api, type FileSourcePresenceCheck } from "@/lib/api";

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
    let active = true;
    const load = () =>
      api
        .listFileSources()
        .then((sources) => {
          if (!active) return;
          setChecks(
            Object.fromEntries(
              sources.flatMap((source) => (source.presenceCheck ? [[source.id, source.presenceCheck] as const] : [])),
            ),
          );
        })
        .catch(() => undefined);
    void load();
    const timer = busy ? window.setInterval(() => void load(), busyPollMs) : null;
    return () => {
      active = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [busy, enabled, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { checks, refresh };
}

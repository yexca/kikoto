import { useEffect, useState } from "react";

import { api, type LibrarySource } from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

/** Uses the public capability list; metadata operators need no settings access. */
export function useMetadataSyncSources(enabled = true) {
  const [sources, setSources] = useState<LibrarySource[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    return startLoad((signal) => api.listLibrarySources(signal), {
      onSuccess: (result) => {
        setSources(result);
        setFailed(false);
      },
      onError: () => setFailed(true),
    });
  }, [enabled, revision]);
  return { sources, failed, retry: () => setRevision((value) => value + 1) };
}

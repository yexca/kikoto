import { useEffect, useState } from "react";

import { api, type LibrarySource } from "@/lib/api";

/** Uses the public capability list; metadata operators need no settings access. */
export function useMetadataSyncSources(enabled = true) {
  const [sources, setSources] = useState<LibrarySource[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    api
      .listLibrarySources()
      .then((result) => {
        if (active) {
          setSources(result);
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [enabled, revision]);
  return { sources, failed, retry: () => setRevision((value) => value + 1) };
}

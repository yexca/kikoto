import { useEffect, useState } from "react";

import { api, type LibraryLayout } from "@/lib/api";

/** The saved library layout, loaded once enabled; the editor replaces it after each save. */
export function useLibraryLayout(enabled: boolean) {
  const [layout, setLayout] = useState<LibraryLayout | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    api
      .getLibraryLayout(controller.signal)
      .then((next) => {
        setLayout(next);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [enabled]);

  return { layout, failed, setLayout };
}

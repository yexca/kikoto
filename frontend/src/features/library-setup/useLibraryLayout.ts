import { useEffect, useState } from "react";

import { api, type LibraryLayout } from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

/** The saved library layout, loaded once enabled; the editor replaces it after each save. */
export function useLibraryLayout(enabled: boolean) {
  const [layout, setLayout] = useState<LibraryLayout | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    return startLoad((signal) => api.getLibraryLayout(signal), {
      onSuccess: (next) => {
        setLayout(next);
        setFailed(false);
      },
      onError: () => setFailed(true),
    });
  }, [enabled]);

  return { layout, failed, setLayout };
}

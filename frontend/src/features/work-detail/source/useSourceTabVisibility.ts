import { useEffect, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import {
  readSourceVisibility,
  withSourceVisibilityMode,
  writeSourceVisibility,
  type SourceVisibilityKey,
  type SourceVisibilityMode,
} from "@/components/source-visibility/sourceVisibility";
import { currentClientStorageScope } from "@/lib/clientStorageScope";

const storagePrefix = "kikoto:detail-source-visibility:";

/** Per-viewer visibility of the work detail directory source tabs, kept in this browser. */
export function useSourceTabVisibility() {
  const auth = useAuth();
  const storageKey = `${storagePrefix}${currentClientStorageScope(auth.user?.id ?? null)}`;
  const [preferences, setPreferences] = useState(() => readSourceVisibility(storageKey));

  useEffect(() => {
    setPreferences(readSourceVisibility(storageKey));
  }, [storageKey]);

  const changeMode = (key: SourceVisibilityKey, mode: SourceVisibilityMode) => {
    setPreferences((current) => {
      const next = withSourceVisibilityMode(current, key, mode);
      writeSourceVisibility(storageKey, next);
      return next;
    });
  };

  return { preferences, changeMode };
}

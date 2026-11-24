import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, type LibrarySource } from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

import { sourceVisibilityIcon, type SourceVisibilityRow } from "@/components/source-visibility/SourceVisibilityPicker";
import {
  remoteSourceVisibilityKey,
  sourceVisibilityMode,
  sourceVisible,
  withSourceVisibilityMode,
  type SourceVisibilityKey,
  type SourceVisibilityMode,
} from "@/components/source-visibility/sourceVisibility";

import {
  autoLibrarySourceVisible,
  readLibrarySourceVisibility,
  writeLibrarySourceVisibility,
} from "./librarySourceVisibility";

/**
 * Per-viewer visibility of the Library source bar entries. `refreshKey` re-checks
 * whether any tracked work exists, which drives Tracked's automatic mode.
 */
export function useLibrarySourceVisibility({
  storageScope,
  sources,
  active,
  refreshKey,
}: {
  storageScope: string;
  sources: LibrarySource[];
  active: boolean;
  refreshKey: string;
}) {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState(() => readLibrarySourceVisibility(storageScope));
  const [hasTrackedWorks, setHasTrackedWorks] = useState<boolean | null>(null);

  useEffect(() => {
    setPreferences(readLibrarySourceVisibility(storageScope));
  }, [storageScope]);

  // A retained workspace that becomes active again keeps its last answer instead of refetching.
  const probedKey = useRef("");
  useEffect(() => {
    const key = `${storageScope}\n${refreshKey}`;
    if (!active || probedKey.current === key) return;
    probedKey.current = key;
    let settled = false;
    const cancel = startLoad(
      (signal) => api.listWorksPage(1, 1, "", "tracked", "all", "recent", "desc", 1, false, signal),
      {
        onSuccess: (page) => setHasTrackedWorks(page.total > 0),
        // Keep Tracked reachable when its presence cannot be determined.
        onError: () => setHasTrackedWorks((current) => current ?? true),
        onSettled: () => {
          settled = true;
        },
      },
    );
    return () => {
      if (settled) return;
      // An interrupted probe is retried the next time this key is active.
      cancel();
      probedKey.current = "";
    };
  }, [active, refreshKey, storageScope]);

  const rows = useMemo<SourceVisibilityRow[]>(() => {
    const row = (key: SourceVisibilityKey, label: string, source?: LibrarySource) => {
      const mode = sourceVisibilityMode(preferences, key);
      return {
        key,
        label,
        icon: sourceVisibilityIcon(key),
        mode,
        visible: sourceVisible(mode, autoLibrarySourceVisible(key, { hasTrackedWorks, source })),
        note: source && !source.enabled ? t("library.sourceVisibility.disabled") : undefined,
      };
    };
    return [
      row("local", t("library.local")),
      row("tracked", t("library.tracked")),
      ...sources.map((source) => row(remoteSourceVisibilityKey(source.id), source.displayName, source)),
    ];
  }, [hasTrackedWorks, preferences, sources, t]);

  const visibleKeys = useMemo(() => new Set(rows.filter((item) => item.visible).map((item) => item.key)), [rows]);

  const changeMode = (key: SourceVisibilityKey, mode: SourceVisibilityMode) => {
    setPreferences((current) => {
      const next = withSourceVisibilityMode(current, key, mode);
      writeLibrarySourceVisibility(storageScope, next);
      return next;
    });
  };

  return { rows, visibleKeys, changeMode };
}

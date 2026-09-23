import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, type LibrarySource } from "@/lib/api";

import {
  autoLibrarySourceVisible,
  librarySourceVisibilityMode,
  librarySourceVisible,
  readLibrarySourceVisibility,
  remoteSourceVisibilityKey,
  withLibrarySourceVisibilityMode,
  writeLibrarySourceVisibility,
  type LibrarySourceVisibilityKey,
  type LibrarySourceVisibilityMode,
} from "./librarySourceVisibility";
import { librarySourceVisibilityIcon, type LibrarySourceVisibilityRow } from "./LibrarySourceVisibilityPicker";

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
    const controller = new AbortController();
    let settled = false;
    api
      .listWorksPage(1, 1, "", "tracked", "all", "recent", "desc", 1, false, controller.signal)
      .then((page) => setHasTrackedWorks(page.total > 0))
      .catch(() => {
        if (controller.signal.aborted) return;
        // Keep Tracked reachable when its presence cannot be determined.
        setHasTrackedWorks((current) => current ?? true);
      })
      .finally(() => {
        settled = true;
      });
    return () => {
      if (settled) return;
      // An interrupted probe is retried the next time this key is active.
      controller.abort();
      probedKey.current = "";
    };
  }, [active, refreshKey, storageScope]);

  const rows = useMemo<LibrarySourceVisibilityRow[]>(() => {
    const row = (key: LibrarySourceVisibilityKey, label: string, source?: LibrarySource) => {
      const mode = librarySourceVisibilityMode(preferences, key);
      return {
        key,
        label,
        icon: librarySourceVisibilityIcon(key),
        mode,
        visible: librarySourceVisible(mode, autoLibrarySourceVisible(key, { hasTrackedWorks, source })),
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

  const changeMode = (key: LibrarySourceVisibilityKey, mode: LibrarySourceVisibilityMode) => {
    setPreferences((current) => {
      const next = withLibrarySourceVisibilityMode(current, key, mode);
      writeLibrarySourceVisibility(storageScope, next);
      return next;
    });
  };

  return { rows, visibleKeys, changeMode };
}

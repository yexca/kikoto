import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { writeDemoMetadataLanguages } from "@/lib/demoMetadataLanguages";
import { USER_PREFERENCES_CHANGED } from "@/lib/recommendationSession";
import {
  dlsiteMetadataLanguagesFor,
  preferredDlsiteMetadataLanguage,
  type DlsiteMetadataLanguage,
} from "./metadataLanguageModel";

export type MetadataDisplayLanguageState = {
  /** Null until the preference has loaded; "origin" when the user has no preference. */
  value: DlsiteMetadataLanguage | null;
  busy: boolean;
  failed: boolean;
  change: (next: DlsiteMetadataLanguage) => Promise<void>;
};

/**
 * Loads and saves the signed-in user's preferred metadata language. The
 * preference is read only once `enabled` becomes true, so surfaces that open
 * on demand do not request it for every page view. Choosing the original
 * language clears the preference. Demo keeps the choice in this browser,
 * because every Demo visitor shares one account. A saved change refreshes the
 * visible page through the user preference event.
 */
export function useMetadataDisplayLanguage(
  enabled: boolean,
  userId: number | null,
  demoMode = false,
): MetadataDisplayLanguageState {
  const [value, setValue] = useState<DlsiteMetadataLanguage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadedUserId, setLoadedUserId] = useState<number | null>(null);
  const loaded = value !== null && loadedUserId === userId;

  useEffect(() => {
    if (!enabled || loaded || userId === null) return;
    const controller = new AbortController();
    setFailed(false);
    api
      .getUserPreferences(controller.signal)
      .then((preferences) => {
        if (controller.signal.aborted) return;
        setValue(preferredDlsiteMetadataLanguage(preferences.metadataLanguages));
        setLoadedUserId(userId);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [enabled, loaded, userId]);

  const change = async (next: DlsiteMetadataLanguage) => {
    if (busy || next === value || userId === null) return;
    setBusy(true);
    setFailed(false);
    try {
      const metadataLanguages = next === "origin" ? null : dlsiteMetadataLanguagesFor(next);
      if (demoMode) {
        writeDemoMetadataLanguages(metadataLanguages);
        setValue(next);
      } else {
        const preferences = await api.updateUserPreferences({ metadataLanguages });
        setValue(preferredDlsiteMetadataLanguage(preferences.metadataLanguages));
      }
      window.dispatchEvent(new CustomEvent(USER_PREFERENCES_CHANGED, { detail: currentClientStorageScope(userId) }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return { value: loaded ? value : null, busy, failed, change };
}

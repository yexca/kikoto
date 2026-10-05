import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { USER_PREFERENCES_CHANGED } from "@/lib/recommendationSession";
import {
  dlsiteMetadataLanguagesFor,
  preferredDlsiteMetadataLanguage,
  type DlsiteMetadataLanguage,
  type MetadataLanguageChoice,
} from "./metadataLanguageModel";

export type MetadataDisplayLanguageState = {
  /** Null until the preference has loaded; "default" follows the instance default. */
  value: MetadataLanguageChoice | null;
  /** The instance default shown with the "default" choice. */
  defaultValue: DlsiteMetadataLanguage | null;
  busy: boolean;
  failed: boolean;
  change: (next: MetadataLanguageChoice) => Promise<void>;
};

/**
 * Loads and saves the signed-in user's preferred metadata language. The
 * preference is read only once `enabled` becomes true, so surfaces that open
 * on demand do not request it for every page view. A saved change refreshes
 * the visible page through the user preference event.
 */
export function useMetadataDisplayLanguage(enabled: boolean, userId: number | null): MetadataDisplayLanguageState {
  const [value, setValue] = useState<MetadataLanguageChoice | null>(null);
  const [defaultValue, setDefaultValue] = useState<DlsiteMetadataLanguage | null>(null);
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
        setDefaultValue(preferredDlsiteMetadataLanguage(preferences.defaultMetadataLanguages));
        setValue(
          preferences.metadataLanguages ? preferredDlsiteMetadataLanguage(preferences.metadataLanguages) : "default",
        );
        setLoadedUserId(userId);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [enabled, loaded, userId]);

  const change = async (next: MetadataLanguageChoice) => {
    if (busy || next === value || userId === null) return;
    setBusy(true);
    setFailed(false);
    try {
      const preferences = await api.updateUserPreferences({
        metadataLanguages: next === "default" ? null : dlsiteMetadataLanguagesFor(next),
      });
      setDefaultValue(preferredDlsiteMetadataLanguage(preferences.defaultMetadataLanguages));
      setValue(
        preferences.metadataLanguages ? preferredDlsiteMetadataLanguage(preferences.metadataLanguages) : "default",
      );
      window.dispatchEvent(new CustomEvent(USER_PREFERENCES_CHANGED, { detail: currentClientStorageScope(userId) }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return { value: loaded ? value : null, defaultValue, busy, failed, change };
}

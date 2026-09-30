import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import {
  dlsiteMetadataLanguagesFor,
  preferredDlsiteMetadataLanguage,
  type DlsiteMetadataLanguage,
} from "./metadataLanguageModel";

export type MetadataDisplayLanguageState = {
  /** Null until the instance setting has loaded. */
  value: DlsiteMetadataLanguage | null;
  busy: boolean;
  failed: boolean;
  change: (next: DlsiteMetadataLanguage) => Promise<void>;
};

/**
 * Loads and saves the instance-wide preferred DLsite metadata language. The
 * setting is read only once `enabled` becomes true, so surfaces that open on
 * demand do not request instance settings for every page view.
 */
export function useMetadataDisplayLanguage(enabled: boolean): MetadataDisplayLanguageState {
  const [value, setValue] = useState<DlsiteMetadataLanguage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const loaded = value !== null;

  useEffect(() => {
    if (!enabled || loaded) return;
    let active = true;
    setFailed(false);
    api
      .getSettings()
      .then((settings) => {
        if (active) setValue(preferredDlsiteMetadataLanguage(settings.dlsiteMetadataLanguages));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [enabled, loaded]);

  const change = async (next: DlsiteMetadataLanguage) => {
    if (busy || next === value) return;
    setBusy(true);
    setFailed(false);
    try {
      const settings = await api.updateSettings({ dlsiteMetadataLanguages: dlsiteMetadataLanguagesFor(next) });
      setValue(preferredDlsiteMetadataLanguage(settings.dlsiteMetadataLanguages));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return { value, busy, failed, change };
}

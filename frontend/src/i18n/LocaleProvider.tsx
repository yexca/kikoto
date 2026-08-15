import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

import i18n, {
  normalizeUiLocale,
  readAnonymousUiLocale,
  resolveUiLocale,
  type ResolvedUiLocale,
  type UiLocale,
  writeAnonymousUiLocale,
} from "@/i18n";

type LocaleContextValue = {
  preference: UiLocale;
  resolvedLocale: ResolvedUiLocale;
  setPreference: (value: UiLocale) => void;
  syncAccountPreference: (userID: number | null, value: unknown, demoMode?: boolean) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<UiLocale>(() => readAnonymousUiLocale());
  const [systemLanguages, setSystemLanguages] = useState(() => {
    if (typeof navigator === "undefined") return ["en"];
    return [...(navigator.languages ?? []), navigator.language].filter(Boolean);
  });
  const [accountID, setAccountID] = useState<number | null>(null);
  const resolvedLocale = useMemo(() => resolveUiLocale(preference, systemLanguages), [preference, systemLanguages]);

  useEffect(() => {
    void i18n.changeLanguage(resolvedLocale);
    document.documentElement.lang =
      resolvedLocale === "zh-Hans" ? "zh-Hans" : resolvedLocale === "zh-Hant" ? "zh-Hant" : resolvedLocale;
    document.documentElement.dir = "ltr";
  }, [resolvedLocale]);

  useEffect(() => {
    const handleLanguageChange = () => {
      if (preference === "auto") {
        const languages =
          typeof navigator === "undefined"
            ? ["en"]
            : [...(navigator.languages ?? []), navigator.language].filter(Boolean);
        setSystemLanguages(languages);
      }
    };
    window.addEventListener("languagechange", handleLanguageChange);
    return () => window.removeEventListener("languagechange", handleLanguageChange);
  }, [preference]);

  const setPreference = useCallback(
    (value: UiLocale) => {
      const normalized = normalizeUiLocale(value);
      setPreferenceState(normalized);
      if (accountID === null) writeAnonymousUiLocale(normalized);
    },
    [accountID],
  );

  const syncAccountPreference = useCallback((userID: number | null, value: unknown, demoMode = false) => {
    const persistedAccountID = userID !== null && !demoMode ? userID : null;
    setAccountID(persistedAccountID);
    if (persistedAccountID !== null) {
      setPreferenceState(normalizeUiLocale(value));
      return;
    }
    setPreferenceState(readAnonymousUiLocale());
  }, []);

  const context = useMemo<LocaleContextValue>(
    () => ({ preference, resolvedLocale, setPreference, syncAccountPreference }),
    [preference, resolvedLocale, setPreference, syncAccountPreference],
  );

  return (
    <I18nextProvider i18n={i18n}>
      <LocaleContext.Provider value={context}>{children}</LocaleContext.Provider>
    </I18nextProvider>
  );
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used inside LocaleProvider");
  return value;
}

import { createContext, useCallback, useContext, useState } from "react";

/** True while the directory shows real file and folder names in place of their display names. */
export const DirectoryOriginalNamesContext = createContext(false);

export function useDirectoryOriginalNames() {
  return useContext(DirectoryOriginalNamesContext);
}

const originalNamesKey = "kikoto:work-directory-original-names";

/** Remembers whether this viewer asked the directory for real names. */
export function useOriginalNamesPreference() {
  const [original, setOriginal] = useState(() => {
    try {
      return localStorage.getItem(originalNamesKey) === "true";
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setOriginal((current) => {
      const next = !current;
      try {
        localStorage.setItem(originalNamesKey, String(next));
      } catch {
        // The choice still applies to this page view.
      }
      return next;
    });
  }, []);
  return [original, toggle] as const;
}

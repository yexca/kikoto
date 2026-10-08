import { useEffect, useState } from "react";

import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";

import { readLibraryCoverSourceMode, writeLibraryCoverSourceMode } from "./libraryCoverSources";

/** The viewer's Library cover source mark mode, kept in this browser. */
export function useLibraryCoverSourceMode(storageScope: string) {
  const [mode, setMode] = useState(() => readLibraryCoverSourceMode(storageScope));

  useEffect(() => {
    setMode(readLibraryCoverSourceMode(storageScope));
  }, [storageScope]);

  const changeMode = (next: SourceVisibilityMode) => {
    setMode(next);
    writeLibraryCoverSourceMode(storageScope, next);
  };

  return [mode, changeMode] as const;
}

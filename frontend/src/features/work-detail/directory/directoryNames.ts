import { createContext, useContext } from "react";

/** True while the directory shows real file and folder names in place of their display names. */
export const DirectoryOriginalNamesContext = createContext(false);

export function useDirectoryOriginalNames() {
  return useContext(DirectoryOriginalNamesContext);
}

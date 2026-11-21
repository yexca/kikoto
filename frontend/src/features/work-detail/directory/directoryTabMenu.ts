import { createContext, useContext } from "react";

/**
 * The source menu of a compact detail's Info and Directory row. The directory
 * panel renders its source controls into `host` while the menu is open, and its
 * name tools into `tools` at the row's end, in place of its own header.
 */
export type DirectoryTabMenu = {
  host: HTMLElement | null;
  tools: HTMLElement | null;
  close: () => void;
};

export const DirectoryTabMenuContext = createContext<DirectoryTabMenu | null>(null);

export function useDirectoryTabMenu() {
  return useContext(DirectoryTabMenuContext);
}

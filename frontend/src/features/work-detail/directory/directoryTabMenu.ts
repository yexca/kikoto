import { createContext, useContext } from "react";

/**
 * The menu of a compact detail's Directory tab. The directory panel renders its
 * source controls into `host` while the menu is open, in place of its header.
 */
export type DirectoryTabMenu = {
  host: HTMLElement | null;
  close: () => void;
};

export const DirectoryTabMenuContext = createContext<DirectoryTabMenu | null>(null);

export function useDirectoryTabMenu() {
  return useContext(DirectoryTabMenuContext);
}

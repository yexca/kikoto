import { ArchiveRestore, History, Tags } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type PersonalTab = "history" | "tags" | "data";

/**
 * Listening history, personal tags, and data transfer are Settings destinations for
 * accounts that can read the library. `data` opens the Your data section of Account.
 */
export const personalTabs: ReadonlyArray<{ id: PersonalTab; label: string; labelKey: string; icon: LucideIcon }> = [
  { id: "history", label: "History", labelKey: "nav.history", icon: History },
  { id: "tags", label: "Tags", labelKey: "nav.tags", icon: Tags },
  { id: "data", label: "Your data", labelKey: "nav.userData", icon: ArchiveRestore },
];

export const PERSONAL_TAB_PERMISSION = "library:read";

export function isPersonalTab(tab: string): tab is PersonalTab {
  return personalTabs.some((candidate) => candidate.id === tab);
}

export function personalTabPath(tab: PersonalTab) {
  return `/settings?tab=${tab}`;
}

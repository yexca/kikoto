import {
  sourceVisibilityMode,
  sourceVisible,
  type SourceVisibilityKey,
  type SourceVisibilityPreferences,
} from "@/components/source-visibility/sourceVisibility";

import type { SourceTabInfo } from "./sourceContextModel";

export type SourceTabVisibilityEntry = {
  key: SourceVisibilityKey;
  kind: SourceTabInfo["kind"];
  label: string;
  disabled: boolean;
  visible: boolean;
};

function tabVisible(tab: SourceTabInfo, preferences: SourceVisibilityPreferences) {
  const autoVisible = tab.autoVisible !== false;
  if (!tab.visibilityKey) return autoVisible;
  return sourceVisible(sourceVisibilityMode(preferences, tab.visibilityKey), autoVisible);
}

/**
 * The tabs the directory strip offers. The active tab always stays so the strip
 * never hides where the viewer is. A lone tab is named in the header instead,
 * unless the viewer explicitly chose to always show it.
 */
export function sourceTabStrip(tabs: SourceTabInfo[], preferences: SourceVisibilityPreferences, activeKey: string) {
  const visibleTabs = tabs.filter((tab) => tab.key === activeKey || tabVisible(tab, preferences));
  if (visibleTabs.length === 0 && tabs.length > 0) visibleTabs.push(tabs[0]);
  const alwaysShown = visibleTabs.some(
    (tab) => tab.visibilityKey && sourceVisibilityMode(preferences, tab.visibilityKey) === "always",
  );
  return { visibleTabs, showStrip: visibleTabs.length > 1 || alwaysShown };
}

/** One visibility entry per source, in tab order; several local file sources share one. */
export function sourceTabVisibilityEntries(
  tabs: SourceTabInfo[],
  preferences: SourceVisibilityPreferences,
  labels: { local: string; tracked: string },
): SourceTabVisibilityEntry[] {
  const entries = new Map<SourceVisibilityKey, SourceTabVisibilityEntry>();
  for (const tab of tabs) {
    if (!tab.visibilityKey) continue;
    const visible = tabVisible(tab, preferences);
    const current = entries.get(tab.visibilityKey);
    if (current) {
      current.visible ||= visible;
      continue;
    }
    entries.set(tab.visibilityKey, {
      key: tab.visibilityKey,
      kind: tab.kind,
      label: tab.kind === "local" ? labels.local : tab.kind === "tracked" ? labels.tracked : tab.label,
      disabled: tab.kind === "remote" && tab.autoVisible === false,
      visible,
    });
  }
  return Array.from(entries.values());
}

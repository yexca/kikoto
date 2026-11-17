/** Where the For you settings open: at the tuning, or at the activity report below it. */
export const FOR_YOU_PANELS = ["tuning", "activity"] as const;
export type ForYouPanel = (typeof FOR_YOU_PANELS)[number];

/** Where `panel` in the location opens the settings; the tuning for any other value, null when it names none. */
export function forYouPanelFromSearch(search: string): ForYouPanel | null {
  const panel = new URLSearchParams(search).get("panel");
  if (panel === null) return null;
  return (FOR_YOU_PANELS as readonly string[]).includes(panel) ? (panel as ForYouPanel) : "tuning";
}

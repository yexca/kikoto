/** The For you settings: recommendation tuning, or the account's recommendation activity. */
export const FOR_YOU_PANELS = ["tuning", "activity"] as const;
export type ForYouPanel = (typeof FOR_YOU_PANELS)[number];

/** The settings tab named by `panel` in the location; Tuning for any other value, null when it names none. */
export function forYouPanelFromSearch(search: string): ForYouPanel | null {
  const panel = new URLSearchParams(search).get("panel");
  if (panel === null) return null;
  return (FOR_YOU_PANELS as readonly string[]).includes(panel) ? (panel as ForYouPanel) : "tuning";
}

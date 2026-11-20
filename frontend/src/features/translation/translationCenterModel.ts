import type { BadgeProps } from "@/components/ui/badge";

/** The views of the Translation page, in tab order. */
export const translationCenterViews = ["review", "running", "attention", "history", "coverage"] as const;

export type TranslationCenterView = (typeof translationCenterViews)[number];

/** The view a link names, or null to open the first view shown. */
export function translationCenterViewFromSearch(search: string): TranslationCenterView | null {
  const view = new URLSearchParams(search).get("view");
  return (translationCenterViews as readonly string[]).includes(view ?? "") ? (view as TranslationCenterView) : null;
}

/**
 * The views the page shows. Review is shown only while items wait for it:
 * with auto-accept on, finished items apply and none wait.
 */
export function visibleTranslationCenterViews(autoAccept: boolean, waiting: number): TranslationCenterView[] {
  return translationCenterViews.filter((view) => view !== "review" || !autoAccept || waiting > 0);
}

export function runStatusBadge(status: string): BadgeProps["variant"] {
  switch (status) {
    case "running":
      return "info";
    case "succeeded":
      return "success";
    case "partial":
      return "warning";
    case "failed":
      return "error";
    default:
      return "secondary";
  }
}

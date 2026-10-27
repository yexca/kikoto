import type { BadgeProps } from "@/components/ui/badge";
import type { TranslationRunLanguage } from "@/lib/translationApi";

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

/**
 * The stage one language of a run is in: queued, translating (with its
 * finished items), waiting for review, stopped, or done.
 */
export function runLanguageStage(language: TranslationRunLanguage): {
  stage: "queued" | "translating" | "review" | "done" | "stopped";
  done: number;
  total: number;
  count: number;
} {
  const states = language.states;
  const count = (...keys: (keyof typeof states)[]) => keys.reduce((sum, key) => sum + (states[key] ?? 0), 0);
  const settled = count(
    "ready",
    "accepted",
    "rejected",
    "failed",
    "uncertain",
    "invalid",
    "policy_blocked",
    "cancelled",
  );
  const total = language.total;
  if (count("requesting") > 0 || (count("queued") > 0 && settled > 0)) {
    return { stage: "translating", done: settled, total, count: settled };
  }
  if (count("queued") > 0) return { stage: "queued", done: settled, total, count: count("queued") };
  if (count("ready") > 0) return { stage: "review", done: settled, total, count: count("ready") };
  if (count("failed", "uncertain", "invalid", "policy_blocked") > 0) {
    return { stage: "stopped", done: settled, total, count: count("failed", "uncertain", "invalid", "policy_blocked") };
  }
  return { stage: "done", done: settled, total, count: count("accepted") };
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

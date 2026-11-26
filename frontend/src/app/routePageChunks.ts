import type { AppPage } from "@/lib/appRoutes";
import { preloadableComponent } from "@/lib/preloadableComponent";

// The route pages outside the retained browse workspaces. The current
// location's page starts loading with the app and every page the navigation
// offers once the shell is idle, so opening one renders it at once instead of
// suspending on its chunk.
export const settingsPage = preloadableComponent(() =>
  import("@/pages/SettingsPage").then((module) => module.SettingsPage),
);
export const systemSettingsPage = preloadableComponent(() =>
  import("@/pages/SystemSettingsPage").then((module) => module.SystemSettingsPage),
);
export const cleanupPage = preloadableComponent(() =>
  import("@/pages/CleanupPage").then((module) => module.CleanupPage),
);
export const tagsPage = preloadableComponent(() => import("@/pages/TagsPage").then((module) => module.TagsPage));
export const workManagementPage = preloadableComponent(() =>
  import("@/pages/WorkManagementPage").then((module) => module.WorkManagementPage),
);
export const workflowsPage = preloadableComponent(() =>
  import("@/pages/WorkflowsPage").then((module) => module.WorkflowsPage),
);
export const translationPage = preloadableComponent(() =>
  import("@/pages/TranslationPage").then((module) => module.TranslationPage),
);
export const insightsPage = preloadableComponent(() =>
  import("@/pages/InsightsPage").then((module) => module.InsightsPage),
);
export const forYouPage = preloadableComponent(() => import("@/pages/ForYouPage").then((module) => module.ForYouPage));
export const subscriptionsPage = preloadableComponent(() =>
  import("@/pages/SubscriptionsPage").then((module) => module.SubscriptionsPage),
);
export const recordsPage = preloadableComponent(() =>
  import("@/pages/RecordsPage").then((module) => module.RecordsPage),
);
export const aboutPage = preloadableComponent(() => import("@/pages/AboutPage").then((module) => module.AboutPage));

const routePageChunks: Partial<Record<AppPage, { preload: () => Promise<unknown> }>> = {
  settings: settingsPage,
  system: systemSettingsPage,
  cleanup: cleanupPage,
  tags: tagsPage,
  metadata: workManagementPage,
  workflows: workflowsPage,
  translation: translationPage,
  insights: insightsPage,
  "for-you": forYouPage,
  subscriptions: subscriptionsPage,
  records: recordsPage,
  about: aboutPage,
};

/** Starts loading a route page's chunk; a page without one, or a failed load, is ignored. */
export function preloadRoutePage(page: AppPage) {
  void routePageChunks[page]?.preload().catch(() => {});
}

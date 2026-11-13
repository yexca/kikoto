import { ACTIVITY_PATH, legacyWorkflowActivityPath } from "@/features/workflows/workflowLinks";

import { TAGS_PATH } from "./navigation";
import {
  SYSTEM_SETTINGS_PATH,
  systemSettingsTabAliases,
  systemSettingsTabs,
  type SystemSettingsTab,
} from "../pages/settingsPaths";

function systemTabFor(tab: string): SystemSettingsTab | null {
  if ((systemSettingsTabs as readonly string[]).includes(tab)) return tab as SystemSettingsTab;
  return systemSettingsTabAliases[tab] ?? null;
}

export function legacyLibraryRedirect(pathname: string, search = "") {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  // Translation coverage lives on the Translation page.
  if (
    (path === "/metadata" || path === "/work-management") &&
    new URLSearchParams(search).get("view") === "translation"
  ) {
    const params = new URLSearchParams(search);
    params.set("view", "coverage");
    return `/translation?${params}`;
  }
  if (path === "/work-management" || (path === "/metadata" && pathname !== path)) {
    return `/metadata${normalizedSearch(search)}`;
  }
  if (path === "/runs") return `${ACTIVITY_PATH}${normalizedSearch(search)}`;
  // Activity was a view of the Workflows page; those addresses lead to the Activity page.
  if (path === "/workflows") {
    const activity = legacyWorkflowActivityPath(search);
    if (activity) return activity;
  }
  if (path === "/no-source" || path === "/library/no-source") {
    const params = new URLSearchParams(search);
    params.set("reason", "no_source");
    params.delete("metadataRun");
    return `/metadata?${params}`;
  }
  if (path === "/settings") {
    const params = new URLSearchParams(search);
    const tab = params.get("tab") ?? "";
    if (tab === "appearance") return "/settings";
    if (tab === "history") return "/insights";
    if (tab === "tags") return TAGS_PATH;
    // Instance settings are the System page; its tabs keep their ids.
    const systemTab = systemTabFor(tab);
    if (systemTab) {
      params.set("tab", systemTab);
      return `${SYSTEM_SETTINGS_PATH}?${params}`;
    }
  }
  if (path === "/users") return `${SYSTEM_SETTINGS_PATH}?tab=users`;
  if (path === "/cleanup") return `${SYSTEM_SETTINGS_PATH}?tab=cleanup`;
  if (path === "/maintenance") {
    const params = new URLSearchParams(search);
    const tab = params.get("tab");
    if (!tab) {
      params.set("tab", "library");
      return `${SYSTEM_SETTINGS_PATH}?${params}`;
    }
    if (tab === "routing") {
      params.set("tab", "playback");
      return `/settings?${params}`;
    }
    if (tab === "recommendation") return `/settings?${params}`;
    if (tab && ["overview", "paths", "system", "local", "remote", "security"].includes(tab)) {
      params.set("tab", tab === "security" ? "users" : "library");
      return `${SYSTEM_SETTINGS_PATH}?${params}`;
    }
    if (tab === "library" || tab === "cache" || tab === "users") return `${SYSTEM_SETTINGS_PATH}?${params}`;
    if (tab === "works" || tab === "unlinked" || tab === "metadata") {
      params.delete("tab");
      if (tab === "works" && !params.has("reason")) params.set("reason", "all");
      if (tab === "unlinked") params.set("reason", "no_source");
      if (params.has("metadataRun")) params.set("reason", "metadata");
      else if (tab === "metadata" && params.get("reason") !== "metadata") params.set("tab", "settings");
      return `/metadata${params.size ? `?${params}` : ""}`;
    }
  }
  // Subscriptions is the Discover page; its query names the same view.
  if (path === "/subscriptions") return `/discover${normalizedSearch(search)}`;
  if (path === "/history") return "/insights";
  if (path === "/user-data") return "/settings?tab=data";
  if (path === "/library/all" || path === "/library/remote") {
    return `/${normalizedSearch(search)}`;
  }
  return null;
}

function normalizedSearch(search: string) {
  const value = search.trim();
  if (!value) return "";
  return value.startsWith("?") ? value : `?${value}`;
}

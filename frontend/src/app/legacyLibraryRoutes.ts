import { legacyRunLogPath } from "@/features/workflows/workflowLinks";

import { FOR_YOU_PATH, TAGS_PATH } from "./navigation";
import {
  CLEANUP_PATH,
  SYSTEM_SETTINGS_PATH,
  systemSettingsTabAliases,
  systemSettingsTabs,
  type SystemSettingsTab,
} from "../pages/settingsPaths";

const FOR_YOU_TUNING_PATH = `${FOR_YOU_PATH}?panel=tuning`;

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
  // Metadata settings are the DLsite proxy in System.
  if ((path === "/metadata" || path === "/work-management") && new URLSearchParams(search).get("tab") === "settings") {
    return `${SYSTEM_SETTINGS_PATH}?tab=proxy`;
  }
  if (path === "/work-management" || (path === "/metadata" && pathname !== path)) {
    return `/metadata${normalizedSearch(search)}`;
  }
  // The run log is part of Workflows.
  const runLog = legacyRunLogPath(path, search);
  if (runLog) return runLog;
  if (path === "/no-source" || path === "/library/no-source") {
    const params = new URLSearchParams(search);
    params.set("reason", "all");
    params.delete("metadataRun");
    return `/metadata?${params}`;
  }
  // Cleanup is a page of its own.
  if ((path === "/settings" || path === SYSTEM_SETTINGS_PATH) && new URLSearchParams(search).get("tab") === "cleanup") {
    const params = new URLSearchParams(search);
    params.delete("tab");
    return `${CLEANUP_PATH}${params.size ? `?${params}` : ""}`;
  }
  // Recommendation tuning is For you's settings.
  if (
    (path === "/settings" || path === "/maintenance") &&
    new URLSearchParams(search).get("tab") === "recommendation"
  ) {
    return FOR_YOU_TUNING_PATH;
  }
  // For you is a page of its own.
  if ((path === "/discover" || path === "/subscriptions") && new URLSearchParams(search).get("view") === "for-you") {
    return FOR_YOU_PATH;
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
    if (tab && ["overview", "paths", "system", "local", "remote", "security"].includes(tab)) {
      params.set("tab", tab === "security" ? "users" : "library");
      return `${SYSTEM_SETTINGS_PATH}?${params}`;
    }
    if (tab === "library" || tab === "cache" || tab === "users") return `${SYSTEM_SETTINGS_PATH}?${params}`;
    if (tab === "works" || tab === "unlinked" || tab === "metadata") {
      params.delete("tab");
      if (tab === "works" && !params.has("reason")) params.set("reason", "all");
      if (tab === "unlinked") params.set("reason", "all");
      if (params.has("metadataRun")) params.set("reason", "metadata");
      else if (tab === "metadata" && params.get("reason") !== "metadata") return `${SYSTEM_SETTINGS_PATH}?tab=proxy`;
      return `/metadata${params.size ? `?${params}` : ""}`;
    }
  }
  // Subscriptions is the Discover page; its query names the same view.
  // Followed circles and voice actors are the Favorite view of their own pages.
  if (path === "/favorites") {
    const params = new URLSearchParams(search);
    const entity = params.get("entity");
    if (entity === "circles" || entity === "voices") {
      const target = new URLSearchParams({ filter: "favorite" });
      const query = params.get("q")?.trim();
      if (query) target.set("q", query);
      return `/${entity}?${target}`;
    }
  }
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

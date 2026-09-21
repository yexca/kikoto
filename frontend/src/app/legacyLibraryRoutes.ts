export function legacyLibraryRedirect(pathname: string, search = "") {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/work-management" || (path === "/metadata" && pathname !== path)) {
    return `/metadata${normalizedSearch(search)}`;
  }
  if (path === "/activity" || path === "/runs") {
    const params = new URLSearchParams(search);
    params.set("activity", "1");
    return `/workflows?${params}`;
  }
  if (path === "/no-source" || path === "/library/no-source") {
    const params = new URLSearchParams(search);
    params.set("reason", "no_source");
    params.delete("metadataRun");
    return `/metadata?${params}`;
  }
  if (path === "/settings" && new URLSearchParams(search).get("tab") === "appearance") return "/settings";
  if (path === "/maintenance") {
    const params = new URLSearchParams(search);
    const tab = params.get("tab");
    if (tab === "routing" || tab === "recommendation") {
      params.set("tab", tab === "routing" ? "playback" : "recommendation");
      return `/settings?${params}`;
    }
    if (tab && ["overview", "paths", "system", "local", "remote", "security"].includes(tab)) {
      params.set("tab", tab === "security" ? "users" : "library");
      return `/settings?${params}`;
    }
    if (tab === "library" || tab === "cache" || tab === "users") return `/settings?${params}`;
    if (tab === "works" || tab === "unlinked" || tab === "metadata") {
      params.delete("tab");
      if (tab === "works" && !params.has("reason")) params.set("reason", "all");
      if (tab === "unlinked") params.set("reason", "no_source");
      if (params.has("metadataRun")) params.set("reason", "metadata");
      else if (tab === "metadata" && params.get("reason") !== "metadata") params.set("tab", "settings");
      return `/metadata${params.size ? `?${params}` : ""}`;
    }
  }
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

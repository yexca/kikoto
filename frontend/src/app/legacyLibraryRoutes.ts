export function legacyLibraryRedirect(pathname: string, search = "") {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/activity" || path === "/runs") {
    const params = new URLSearchParams(search);
    params.set("activity", "1");
    return `/workflows?${params}`;
  }
  if (path === "/no-source" || path === "/library/no-source") {
    return "/work-management?reason=no_source";
  }
  if (path === "/maintenance") {
    const params = new URLSearchParams(search);
    const tab = params.get("tab");
    if (tab === "works" || tab === "unlinked" || tab === "metadata") {
      params.delete("tab");
      if (tab === "unlinked") params.set("reason", "no_source");
      if (tab === "metadata" && !params.has("metadataRun")) params.set("tab", "settings");
      return `/work-management${params.size ? `?${params}` : ""}`;
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

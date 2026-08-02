export function legacyLibraryRedirect(pathname: string, search = "") {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/no-source" || path === "/library/no-source") {
    return "/maintenance?tab=unlinked";
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

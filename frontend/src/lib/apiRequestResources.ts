// These scopes describe the existing shared reads, not a response cache.
export function apiReadResources(path: string): readonly string[] {
  const pathname = path.split("?", 1)[0];
  const work = /^\/api\/works\/(\d+)$/.exec(pathname);
  if (work) return ["works", `work:${work[1]}`, "work-state"];
  if (pathname === "/api/runtime-settings") return ["runtime-settings"];
  if (pathname === "/api/tags") return ["user-tags"];
  return [pathname];
}

export function apiMutationResources(path: string): {
  forget: readonly string[] | null;
  interrupt: readonly string[];
} {
  const pathname = path.split("?", 1)[0];
  // Progress is embedded in full work reads, but saving it must never stop a
  // directory load. New callers still need a fresh view of personal state.
  if (/^\/api\/media-items\/\d+\/progress$/.test(pathname) || pathname === "/api/listening-sessions") {
    return { forget: ["work-state"], interrupt: [] };
  }
  if (pathname === "/api/recommendation-events" || /^\/api\/remote-sources\/\d+\/recommendations$/.test(pathname))
    return { forget: [], interrupt: [] };

  const work = /^\/api\/works\/(\d+)(?:\/|$)/.exec(pathname);
  if (work) {
    const resource = `work:${work[1]}`;
    if (/\/(?:local-files\/refresh|tracked-sources\/\d+)$/.test(pathname)) {
      // Media edition resolution may affect sibling reads' reuse too. Only
      // the edited work's running directory requests need to restart.
      return { forget: ["works"], interrupt: [resource] };
    }
    if (/\/(?:user-state|favorite-lists)$/.test(pathname)) return { forget: [resource], interrupt: [] };
    if (/\/tags$/.test(pathname)) return { forget: [resource, "user-tags"], interrupt: [] };
    // Metadata relationships can affect a family whose ids the client does
    // not know. Evict conservatively without interrupting its current views.
    return { forget: ["works"], interrupt: [] };
  }
  if (/^\/api\/(?:user-tags|tags)(?:\/|$)/.test(pathname)) return { forget: ["user-tags", "works"], interrupt: [] };
  if (pathname === "/api/auth/me/preferences") {
    return { forget: ["works", "runtime-settings", "user-tags"], interrupt: [] };
  }
  // Unclassified writes may have wider effects. Preserve freshness with a
  // conservative reuse fence, while keeping all current callers alive.
  return { forget: null, interrupt: [] };
}

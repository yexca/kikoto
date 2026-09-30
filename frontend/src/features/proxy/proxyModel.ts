import type {
  OutboundProxy,
  ProxyRoute,
  ProxyRoutes,
  ProxyScheme,
  ProxySettings,
  ProxySettingsPayload,
  SourceProxyRoute,
} from "@/lib/api";

export const PROXY_SCHEMES: ProxyScheme[] = ["http", "https", "socks5", "socks5h"];

export const DEFAULT_PROXY_PORTS: Record<ProxyScheme, number> = {
  http: 8080,
  https: 443,
  socks5: 1080,
  socks5h: 1080,
};

export type ProxyScope = "dlsite" | "remote" | "other";

export const PROXY_SCOPES: ProxyScope[] = ["dlsite", "remote", "other"];

/** An edited proxy. password is present only when the administrator typed one. */
export type ProxyDraft = OutboundProxy & { password?: string };

export type ProxyConfigDraft = { proxies: ProxyDraft[]; routes: ProxyRoutes; directFallback: boolean };

/**
 * A route's proxy choice as one select value: every proxy by priority, one
 * proxy, or a multi-proxy selection that only the API can create.
 */
export type RouteSelection = "all" | `proxy:${string}` | "custom";

/** A per-source override as one select value. */
export type SourceSelection = "inherit" | "direct" | RouteSelection;

const emptyRoute = (): ProxyRoute => ({ enabled: false, proxyIds: [] });

const draftRoute = (route: ProxyRoute | undefined): ProxyRoute => ({
  enabled: Boolean(route?.enabled),
  proxyIds: route?.proxyIds ?? [],
});

export function proxyConfigDraft(settings: ProxySettings | undefined): ProxyConfigDraft {
  const sources: Record<string, SourceProxyRoute> = {};
  for (const [sourceId, route] of Object.entries(settings?.routes.sources ?? {})) {
    sources[sourceId] = { mode: route.mode, proxyIds: route.proxyIds ?? [] };
  }
  return {
    proxies: (settings?.proxies ?? []).map((proxy) => ({ ...proxy })),
    routes: {
      dlsite: draftRoute(settings?.routes.dlsite),
      remote: draftRoute(settings?.routes.remote),
      other: draftRoute(settings?.routes.other),
      sources,
    },
    directFallback: Boolean(settings?.directFallback),
  };
}

export function proxySettingsPayload(draft: ProxyConfigDraft): ProxySettingsPayload {
  return {
    proxies: draft.proxies.map((proxy) => ({
      id: proxy.id,
      name: proxy.name,
      kind: proxy.kind,
      scheme: proxy.scheme,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      ...(proxy.password === undefined ? {} : { password: proxy.password }),
    })),
    routes: draft.routes,
    directFallback: draft.directFallback,
  };
}

export function sameProxyConfig(left: ProxyConfigDraft, right: ProxyConfigDraft) {
  return JSON.stringify(proxySettingsPayload(left)) === JSON.stringify(proxySettingsPayload(right));
}

export function newProxyId(taken: ReadonlyArray<{ id: string }>) {
  const ids = new Set(taken.map((proxy) => proxy.id));
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = `p${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (!ids.has(id)) return id;
  }
}

export function emptyProxy(taken: ReadonlyArray<{ id: string }>): ProxyDraft {
  return {
    id: newProxyId(taken),
    name: "",
    kind: "host",
    scheme: "http",
    host: "",
    port: DEFAULT_PROXY_PORTS.http,
    username: "",
    hasPassword: false,
  };
}

/** The address a proxy is reached at from the server, for display. */
export function proxyAddress(proxy: Pick<OutboundProxy, "kind" | "host" | "port">, hostAddress: string) {
  const host = proxy.kind === "host" ? hostAddress : proxy.host;
  return `${host.includes(":") ? `[${host}]` : host}:${proxy.port}`;
}

export function proxyDraftValid(proxy: ProxyDraft) {
  const portValid = Number.isInteger(proxy.port) && proxy.port >= 1 && proxy.port <= 65535;
  const hostValid = proxy.kind === "host" || /^[^\s/@?#]+$/.test(proxy.host.trim());
  const passwordValid = !proxy.password || proxy.username.trim() !== "";
  return portValid && hostValid && passwordValid;
}

/** Adds or replaces a proxy, keeping list order for an edit. */
export function upsertProxy(draft: ProxyConfigDraft, proxy: ProxyDraft): ProxyConfigDraft {
  const normalized: ProxyDraft = {
    ...proxy,
    name: proxy.name.trim(),
    host: proxy.kind === "host" ? "" : proxy.host.trim(),
    username: proxy.username.trim(),
  };
  if (!normalized.username) {
    normalized.password = normalized.hasPassword ? "" : undefined;
    normalized.hasPassword = false;
  }
  const exists = draft.proxies.some((candidate) => candidate.id === proxy.id);
  return {
    ...draft,
    proxies: exists
      ? draft.proxies.map((candidate) => (candidate.id === proxy.id ? normalized : candidate))
      : [...draft.proxies, normalized],
  };
}

/**
 * Removes a proxy and every reference to it. A selection that loses its only
 * proxy falls back to every proxy; with no proxies left, routes turn off and
 * proxy overrides return to inheriting.
 */
export function removeProxy(draft: ProxyConfigDraft, id: string): ProxyConfigDraft {
  const proxies = draft.proxies.filter((proxy) => proxy.id !== id);
  const prune = (ids: string[]) => ids.filter((candidate) => candidate !== id);
  const route = (value: ProxyRoute): ProxyRoute =>
    proxies.length === 0 ? emptyRoute() : { ...value, proxyIds: prune(value.proxyIds) };
  const sources: Record<string, SourceProxyRoute> = {};
  for (const [sourceId, value] of Object.entries(draft.routes.sources)) {
    if (value.mode === "proxy" && proxies.length === 0) continue;
    sources[sourceId] = { ...value, proxyIds: prune(value.proxyIds) };
  }
  return {
    ...draft,
    proxies,
    routes: {
      dlsite: route(draft.routes.dlsite),
      remote: route(draft.routes.remote),
      other: route(draft.routes.other),
      sources,
    },
  };
}

export function moveProxy(draft: ProxyConfigDraft, id: string, offset: -1 | 1): ProxyConfigDraft {
  const index = draft.proxies.findIndex((proxy) => proxy.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= draft.proxies.length) return draft;
  const proxies = [...draft.proxies];
  [proxies[index], proxies[target]] = [proxies[target], proxies[index]];
  return { ...draft, proxies };
}

export function routeSelection(proxyIds: string[]): RouteSelection {
  if (proxyIds.length === 0) return "all";
  if (proxyIds.length === 1) return `proxy:${proxyIds[0]}`;
  return "custom";
}

function selectionIds(selection: RouteSelection, current: string[]) {
  if (selection === "all") return [];
  if (selection === "custom") return current;
  return [selection.slice("proxy:".length)];
}

export function setRouteEnabled(draft: ProxyConfigDraft, scope: ProxyScope, enabled: boolean): ProxyConfigDraft {
  return { ...draft, routes: { ...draft.routes, [scope]: { ...draft.routes[scope], enabled } } };
}

export function setRouteSelection(
  draft: ProxyConfigDraft,
  scope: ProxyScope,
  selection: RouteSelection,
): ProxyConfigDraft {
  const route = draft.routes[scope];
  return {
    ...draft,
    routes: { ...draft.routes, [scope]: { ...route, proxyIds: selectionIds(selection, route.proxyIds) } },
  };
}

/** The "all" switch is on only when every scope uses a proxy. */
export function allRoutesEnabled(routes: ProxyRoutes) {
  return PROXY_SCOPES.every((scope) => routes[scope].enabled);
}

export function setDirectFallback(draft: ProxyConfigDraft, directFallback: boolean): ProxyConfigDraft {
  return { ...draft, directFallback };
}

export function setAllRoutesEnabled(draft: ProxyConfigDraft, enabled: boolean): ProxyConfigDraft {
  return PROXY_SCOPES.reduce((next, scope) => setRouteEnabled(next, scope, enabled), draft);
}

export function sourceSelection(routes: ProxyRoutes, sourceId: number): SourceSelection {
  const override = routes.sources[String(sourceId)];
  if (!override || override.mode === "inherit") return "inherit";
  if (override.mode === "direct") return "direct";
  return routeSelection(override.proxyIds);
}

export function setSourceSelection(
  draft: ProxyConfigDraft,
  sourceId: number,
  selection: SourceSelection,
): ProxyConfigDraft {
  const key = String(sourceId);
  const sources = { ...draft.routes.sources };
  if (selection === "inherit") delete sources[key];
  else if (selection === "direct") sources[key] = { mode: "direct", proxyIds: [] };
  else sources[key] = { mode: "proxy", proxyIds: selectionIds(selection, sources[key]?.proxyIds ?? []) };
  return { ...draft, routes: { ...draft.routes, sources } };
}

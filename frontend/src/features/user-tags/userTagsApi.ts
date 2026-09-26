import { apiTransport, type UserTagScope } from "@/lib/api";

export type ManagedUserTag = {
  id: number;
  name: string;
  color: string;
  usageCount: number;
};

export type ManagedUserTagPage = {
  scope: UserTagScope;
  tags: ManagedUserTag[];
  total: number;
  page: number;
  pageSize: number;
};

function tagPath(id: number, scope: UserTagScope, suffix = "") {
  return `/api/user-tags/${encodeURIComponent(String(id))}${suffix}?scope=${encodeURIComponent(scope)}`;
}

/** Personal tag management. `GET /api/tags` remains the editor's suggestion vocabulary. */
export const userTagsApi = {
  list: (options: { scope: UserTagScope; query?: string; page: number; pageSize: number }, signal?: AbortSignal) => {
    const search = new URLSearchParams({
      scope: options.scope,
      page: String(options.page),
      pageSize: String(options.pageSize),
    });
    const query = options.query?.trim();
    if (query) search.set("q", query);
    return apiTransport.getJSON<ManagedUserTagPage>(`/api/user-tags?${search}`, signal);
  },
  rename: (scope: UserTagScope, id: number, name: string) =>
    apiTransport.sendJSONBody<ManagedUserTag>("PATCH", tagPath(id, scope), { name }),
  merge: (scope: UserTagScope, sourceId: number, targetId: number) =>
    apiTransport.sendJSONBody<ManagedUserTag>("POST", tagPath(sourceId, scope, "/merge"), { targetId }),
  remove: (scope: UserTagScope, id: number) => apiTransport.deleteJSON<{ deleted: boolean }>(tagPath(id, scope)),
};

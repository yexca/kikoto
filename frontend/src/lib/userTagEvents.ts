import type { UserTagScope } from "@/lib/api";

/**
 * Dispatched after a personal tag is renamed, merged, or deleted. Cached tag
 * vocabularies and retained browse views that show tags must reload.
 */
export const USER_TAGS_CHANGED_EVENT = "kikoto:user-tags-changed";

export type UserTagsChangedDetail = {
  scope: UserTagScope;
};

export function announceUserTagsChanged(scope: UserTagScope) {
  window.dispatchEvent(new CustomEvent<UserTagsChangedDetail>(USER_TAGS_CHANGED_EVENT, { detail: { scope } }));
}

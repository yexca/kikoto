import { maxUserTagNameLength } from "@/components/userTagEditorModel";
import { ApiError } from "@/lib/api";

import type { ManagedUserTag } from "./userTagsApi";

export const USER_TAG_PAGE_SIZE = 50;

export type TagRenameValidation =
  { ok: true; name: string } | { ok: false; reason: "invalid" | "unchanged" | "duplicate" };

/** Names are 1..40 Unicode characters after trimming, matching the backend. */
export function validateTagRename(draft: string, current: ManagedUserTag): TagRenameValidation {
  const name = draft.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > maxUserTagNameLength) return { ok: false, reason: "invalid" };
  if (name === current.name) return { ok: false, reason: "unchanged" };
  return { ok: true, name };
}

/** A rename rejected because another tag in the scope already owns the name. */
export function isDuplicateTagNameError(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

/** Candidates for a merge: every other tag, never the source itself. */
export function mergeTargetCandidates(tags: readonly ManagedUserTag[], source: ManagedUserTag) {
  return tags.filter((tag) => tag.id !== source.id);
}

/**
 * The page to show after one tag disappears. Removing the only row of the last
 * page moves back one page instead of showing an empty page.
 */
export function pageAfterRemoval(page: number, visibleRows: number) {
  return visibleRows <= 1 && page > 1 ? page - 1 : page;
}

export function replaceTag(tags: readonly ManagedUserTag[], updated: ManagedUserTag) {
  return tags.map((tag) => (tag.id === updated.id ? updated : tag));
}

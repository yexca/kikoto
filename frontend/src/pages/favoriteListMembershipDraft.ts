import type { FavoriteListMembershipSummary } from "@/lib/api";

/** Whether all, some, or none of the selected works belong to a list. */
export type ListMembershipState = "all" | "some" | "none";

export type ListMembershipStates = ReadonlyMap<number, ListMembershipState>;

export function membershipStatesFromSummary(summary: FavoriteListMembershipSummary): Map<number, ListMembershipState> {
  const states = new Map<number, ListMembershipState>();
  for (const { listId, count } of summary.lists) {
    states.set(listId, count <= 0 ? "none" : count >= summary.total ? "all" : "some");
  }
  return states;
}

/**
 * Cycles a list row. A list that started mixed can return to "some", which
 * leaves every selected work's membership in that list untouched.
 */
export function nextMembershipState(initial: ListMembershipState, current: ListMembershipState): ListMembershipState {
  if (current === "some") return "all";
  if (current === "all") return "none";
  return initial === "some" ? "some" : "all";
}

/** Only lists whose state changed are sent, so unrelated memberships are preserved. */
export function membershipChanges(initial: ListMembershipStates, current: ListMembershipStates) {
  const addListIds: number[] = [];
  const removeListIds: number[] = [];
  for (const [listID, state] of current) {
    if (state === (initial.get(listID) ?? "none")) continue;
    if (state === "all") addListIds.push(listID);
    else if (state === "none") removeListIds.push(listID);
  }
  return { addListIds, removeListIds };
}

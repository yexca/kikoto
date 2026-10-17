import type { WorkBundleMember, WorkBundleRef } from "@/lib/api";

/** Bundle member changes waiting for Save, by code. */
export type StagedBundleMembers = { add: string[]; remove: string[] };

export const noStagedBundleMembers: StagedBundleMembers = { add: [], remove: [] };

export type BundleMemberRow = {
  code: string;
  title: string;
  workCode: string;
  url: string;
  origin: WorkBundleMember["origin"] | null;
  state: "kept" | "added" | "removed";
};

export function bundleMembersChanged(staged: StagedBundleMembers) {
  return staged.add.length > 0 || staged.remove.length > 0;
}

/** The members as they will be after Save: the stored ones, then staged additions. */
export function bundleMemberRows(
  members: readonly WorkBundleMember[],
  staged: StagedBundleMembers,
  known: readonly WorkBundleRef[] = [],
): BundleMemberRow[] {
  const removed = new Set(staged.remove);
  const rows: BundleMemberRow[] = members.map((member) => ({
    code: member.code,
    title: member.work?.title ?? "",
    workCode: member.work?.code ?? "",
    url: member.url,
    origin: member.origin,
    state: removed.has(member.code) ? "removed" : "kept",
  }));
  for (const code of staged.add) {
    const ref = known.find((item) => item.code === code);
    rows.push({
      code,
      title: ref?.work?.title ?? "",
      workCode: ref?.work?.code ?? "",
      url: ref?.url ?? "",
      origin: null,
      state: "added",
    });
  }
  return rows;
}

/** Stages adding a code; adding a stored member that was staged for removal keeps it. */
export function stageBundleMemberAdd(
  staged: StagedBundleMembers,
  members: readonly WorkBundleMember[],
  code: string,
): StagedBundleMembers {
  if (staged.remove.includes(code)) return { ...staged, remove: staged.remove.filter((item) => item !== code) };
  if (members.some((member) => member.code === code) || staged.add.includes(code)) return staged;
  return { ...staged, add: [...staged.add, code] };
}

/** Stages removing a code; removing a staged addition drops it. */
export function stageBundleMemberRemove(staged: StagedBundleMembers, code: string): StagedBundleMembers {
  if (staged.add.includes(code)) return { ...staged, add: staged.add.filter((item) => item !== code) };
  if (staged.remove.includes(code)) return staged;
  return { ...staged, remove: [...staged.remove, code] };
}

/** Undoes a staged change to one code. */
export function unstageBundleMember(staged: StagedBundleMembers, code: string): StagedBundleMembers {
  return { add: staged.add.filter((item) => item !== code), remove: staged.remove.filter((item) => item !== code) };
}

/** Suggestions that are neither members nor staged additions. */
export function openBundleCandidates(
  candidates: readonly WorkBundleRef[],
  members: readonly WorkBundleMember[],
  staged: StagedBundleMembers,
) {
  const taken = new Set([...members.map((member) => member.code), ...staged.add]);
  return candidates.filter((candidate) => !taken.has(candidate.code));
}

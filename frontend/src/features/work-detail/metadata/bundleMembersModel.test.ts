import { describe, expect, it } from "vitest";

import type { WorkBundleMember } from "@/lib/api";

import {
  bundleMemberRows,
  bundleMembersChanged,
  noStagedBundleMembers,
  openBundleCandidates,
  stageBundleMemberAdd,
  stageBundleMemberRemove,
  unstageBundleMember,
} from "./bundleMembersModel";

const members: WorkBundleMember[] = [
  {
    code: "RJ00000011",
    origin: "detected",
    url: "https://www.example.invalid/RJ00000011",
    work: { id: 11, code: "RJ00000011", title: "Example Work 11" },
  },
  { code: "RJ00000012", origin: "user", url: "https://www.example.invalid/RJ00000012" },
];

describe("bundle member staging", () => {
  it("shows stored members, then additions, with what Save will do", () => {
    let staged = stageBundleMemberAdd(noStagedBundleMembers, members, "RJ00000013");
    staged = stageBundleMemberRemove(staged, "RJ00000012");
    expect(bundleMembersChanged(staged)).toBe(true);
    expect(bundleMemberRows(members, staged).map((row) => [row.code, row.state])).toEqual([
      ["RJ00000011", "kept"],
      ["RJ00000012", "removed"],
      ["RJ00000013", "added"],
    ]);
  });

  it("cancels opposite changes instead of staging both", () => {
    const removed = stageBundleMemberRemove(noStagedBundleMembers, "RJ00000011");
    expect(stageBundleMemberAdd(removed, members, "RJ00000011")).toEqual(noStagedBundleMembers);
    const added = stageBundleMemberAdd(noStagedBundleMembers, members, "RJ00000013");
    expect(stageBundleMemberRemove(added, "RJ00000013")).toEqual(noStagedBundleMembers);
    expect(stageBundleMemberAdd(noStagedBundleMembers, members, "RJ00000011")).toBe(noStagedBundleMembers);
    expect(unstageBundleMember(added, "RJ00000013")).toEqual(noStagedBundleMembers);
  });

  it("offers only suggestions that are not listed or staged", () => {
    const staged = stageBundleMemberAdd(noStagedBundleMembers, members, "RJ00000013");
    const candidates = ["RJ00000011", "RJ00000013", "RJ00000014"].map((code) => ({ code, url: "" }));
    expect(openBundleCandidates(candidates, members, staged).map((candidate) => candidate.code)).toEqual([
      "RJ00000014",
    ]);
  });
});
